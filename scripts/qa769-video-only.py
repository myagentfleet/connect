#!/usr/bin/env python3
"""Remove AAC from the fixed QA769 clips without remuxing their video packets.

This creates diagnostic media only. It does not change the Connect fixtures.
"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess


EXPECTED = {
    "complete.m3u8": "3b9c3967df955376b969409358c35d1840f5728ee66a842d257039c688cd3fda",
    "0/qcamera.ts": "d2616e37b45e2c0628af3545fa12fcb2db8945cfbf3799f882c97ffe4636c61b",
    "1/qcamera.ts": "d19d3985238becc0d20b5a7eec47f118ab22df856661844342b9d242ea837f48",
    "2/qcamera.ts": "e2c74fb5ea4beaaa778d3eae4b0294023b8b01beb28c8a20d1d0187bbb07c3e8",
}
VIDEO_PID, AUDIO_PID, PMT_PID, NULL_PID = 0x100, 0x101, 0x1000, 0x1FFF
ORIGINAL_PMT = bytes.fromhex("02b0170001c10000e100f0001be100f0000fe101f0002f44b99b")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def crc32_mpeg2(data):
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte << 24
        for _ in range(8):
            crc = ((crc << 1) ^ (0x04C11DB7 if crc & 0x80000000 else 0)) & 0xFFFFFFFF
    return crc


def packet_pid(packet):
    return ((packet[1] & 0x1F) << 8) | packet[2]


def packets(data):
    require(len(data) % 188 == 0, "Input must contain complete 188-byte TS packets")
    result = [data[i:i + 188] for i in range(0, len(data), 188)]
    require(all(p[0] == 0x47 and not p[1] & 0x80 for p in result), "Invalid TS sync or transport error")
    return result


def has_pcr(packet):
    return bool(packet[3] & 0x20 and packet[4] > 0 and packet[5] & 0x10)


def remove_pmt_audio(packet):
    require(packet_pid(packet) == PMT_PID and packet[1] & 0x40, "Expected a complete PMT section")
    control = (packet[3] >> 4) & 3
    require(control & 1, "PMT packet must contain payload")
    offset = 4 + (1 + packet[4] if control & 2 else 0)
    offset += 1 + packet[offset]
    section_length = 3 + ((packet[offset + 1] & 15) << 8) + packet[offset + 2]
    section = packet[offset:offset + section_length]
    require(section == ORIGINAL_PMT, "Unexpected PMT; this helper is specific to the pinned fixture")
    require(crc32_mpeg2(section) == 0, "Original PMT CRC is invalid")
    require(((section[8] & 31) << 8) | section[9] == VIDEO_PID, "PCR must stay on the video PID")
    require(section[12:17] == bytes.fromhex("1be100f000"), "Unexpected H264 PMT entry")
    require(section[17:22] == bytes.fromhex("0fe101f000"), "Unexpected AAC PMT entry")
    require(all(byte == 0xFF for byte in packet[offset + section_length:]), "Unexpected data after PMT")

    # Preserve program/PCR metadata and the H264 entry; remove only AAC's entry.
    updated = bytearray(section[:17])
    new_section_length = len(updated) + 4 - 3
    updated[1] = (updated[1] & 0xF0) | (new_section_length >> 8)
    updated[2] = new_section_length & 0xFF
    updated.extend(crc32_mpeg2(updated).to_bytes(4, "big"))
    require(crc32_mpeg2(updated) == 0, "Generated PMT CRC is invalid")
    return packet[:offset] + bytes(updated) + bytes([0xFF]) * (188 - offset - len(updated))


def transform(data):
    original = packets(data)
    output = []
    for packet in original:
        pid = packet_pid(packet)
        if pid == AUDIO_PID:
            require(not has_pcr(packet), "Removing an AAC packet must not remove PCR")
            # Keep packet length, position and all other packets. Null PID has no elementary stream.
            output.append(bytes([0x47, 0x1F, 0xFF, 0x10 | (packet[3] & 15)]) + bytes([0xFF]) * 184)
        elif pid == PMT_PID:
            output.append(remove_pmt_audio(packet))
        else:
            output.append(packet)

    video_indices = [i for i, p in enumerate(original) if packet_pid(p) == VIDEO_PID]
    pcr_indices = [i for i, p in enumerate(original) if has_pcr(p)]
    audio_indices = [i for i, p in enumerate(original) if packet_pid(p) == AUDIO_PID]
    pmt_indices = [i for i, p in enumerate(original) if packet_pid(p) == PMT_PID]
    require(video_indices and audio_indices and len(pmt_indices) == 6, "Expected original video/audio and six PMTs")
    require(len(pcr_indices) == 300 and set(pcr_indices).issubset(video_indices), "Expected 300 video PCR packets")
    require(video_indices == [i for i, p in enumerate(output) if packet_pid(p) == VIDEO_PID], "Video positions changed")
    require(pcr_indices == [i for i, p in enumerate(output) if has_pcr(p)], "PCR positions changed")
    require(all(original[i] == output[i] for i in video_indices + pcr_indices), "Video or PCR bytes changed")
    require(all(original[i] == output[i] for i in range(len(original)) if i not in audio_indices + pmt_indices),
            "A packet outside AAC/PMT was changed")
    require(all(packet_pid(output[i]) == NULL_PID for i in audio_indices), "AAC was not replaced by null packets")
    require(not any(packet_pid(p) == AUDIO_PID for p in output), "An AAC packet remains")
    result = b"".join(output)
    require(len(result) == len(data), "File size changed")
    return result, {
        "bytes": len(data), "packets": len(original), "audio_packets_replaced": len(audio_indices),
        "pmt_packets_updated": len(pmt_indices), "video_packets": len(video_indices), "pcr_packets": len(pcr_indices),
        "video_packet_indices_sha256": sha256(json.dumps(video_indices).encode()),
        "video_ts_packets_sha256": sha256(b"".join(original[i] for i in video_indices)),
        "pcr_packet_indices_sha256": sha256(json.dumps(pcr_indices).encode()),
        "pcr_ts_packets_sha256": sha256(b"".join(original[i] for i in pcr_indices)),
        "same_file_size": True, "same_video_packets_and_positions": True,
        "same_pcr_packets_and_positions": True, "all_other_packets_unchanged": True, "pmt_crc_valid": True,
    }


def inspect(path):
    return json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_programs", "-of", "json", str(path)))


def video_packets(path):
    return json.loads(run("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_packets", "-show_data_hash", "sha256",
                          "-show_entries", "packet=pts,dts,duration,size,data_hash", "-of", "json", str(path)))["packets"]


def elementary_hash(path):
    return sha256(run("ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-map", "0:v:0", "-c:v", "copy", "-f", "h264", "-"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True, help="Original public/demo-video directory")
    parser.add_argument("--output", type=Path, required=True, help="New diagnostic output directory; must not exist")
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    require(source != output and source not in output.parents, "Output must be outside the original fixture directory")
    inputs = {name: (source / name).read_bytes() for name in EXPECTED}
    require(all(sha256(data) == EXPECTED[name] for name, data in inputs.items()), "Source fixture SHA256 mismatch")
    generated = {name: transform(data) for name, data in inputs.items() if name.endswith(".ts")}
    output.mkdir(parents=True, exist_ok=False)
    (output / "complete.m3u8").write_bytes(inputs["complete.m3u8"])
    report = {
        "diagnostic_only": True,
        "operation": "Replace AAC PID0x101 packets with null TS packets; remove AAC from PMT and recompute MPEG2 CRC. No remux or re-encode.",
        "limits": "Audio removal also changes Hls initPTS normalization: the original AAC leads video by64ms, so video-only may start at0 rather than0.064. This does not isolate audio-clock behavior from startup-gap behavior or prove application acceptance.",
        "source_sha256": EXPECTED, "manifest_unchanged": True,
        "ffmpeg": run("ffmpeg", "-version").decode().splitlines()[0],
        "ffprobe": run("ffprobe", "-version").decode().splitlines()[0],
        "segments": {},
    }
    for name, (data, checks) in generated.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        original_info, info = inspect(source / name), inspect(target)
        require([s["codec_name"] for s in original_info["streams"]] == ["h264", "aac"], "Original streams differ")
        require([s["codec_name"] for s in info["streams"]] == ["h264"], "Output must contain only H264")
        require(info["programs"][0]["pcr_pid"] == VIDEO_PID, "Output PCR PID changed")
        original_packets, modified_packets = video_packets(source / name), video_packets(target)
        require(original_packets == modified_packets and len(modified_packets) == 300, "Video PES data or timestamps changed")
        original_hash, modified_hash = elementary_hash(source / name), elementary_hash(target)
        require(original_hash == modified_hash, "Extracted H264 elementary stream changed")
        run("ffmpeg", "-v", "error", "-xerror", "-err_detect", "explode", "-i", str(target),
            "-map", "0:v:0", "-f", "null", "-")
        report["segments"][name] = {
            **checks, "sha256": sha256(data), "h264_elementary_sha256": modified_hash,
            "video_pes_count": len(modified_packets), "same_video_pes_data_and_timestamps": True,
            "same_h264_elementary_stream": True, "strict_decode_passed": True,
            "video_start_time": info["streams"][0]["start_time"], "video_duration": info["streams"][0]["duration"],
            "video_frame_rate": info["streams"][0]["avg_frame_rate"], "pcr_pid": info["programs"][0]["pcr_pid"],
        }
    require(all((source / name).read_bytes() == data for name, data in inputs.items()), "An original fixture changed")
    report["original_files_unchanged"] = True
    (output / "provenance.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"output": str(output), "segments": len(generated), "checks_passed": True,
                      "total_audio_packets_replaced": sum(c[1]["audio_packets_replaced"] for c in generated.values())}))


if __name__ == "__main__":
    main()
