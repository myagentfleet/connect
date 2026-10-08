# Playback fixtures

These synthetic clips show an elapsed-time counter and play a quiet, continuous
440 Hz tone. They contain no driving footage. `complete.m3u8` plays three 60-second
segments. `missing-first.m3u8` and `missing-middle.m3u8` keep the same durations and
timestamps, replacing exactly one segment URL with a missing Azure Blob URL.
Those URLs returned HTTP 404 `BlobNotFound` with `Access-Control-Allow-Origin: *`
when checked on 2026-10-08; they contain no expiring credentials.

Serve these files normally over HTTP. Both native HLS and hls.js encounter the
same missing-fragment request. There is no Blob manifest, service worker,
custom loader, or `EXT-X-GAP` shortcut. A local missing path is not used because
an SPA host may serve `index.html` with status 200 for it.

The `/demo` routes titled **Synthetic playback** use these media files and their
own synthetic events, coordinates, and thumbnails. Route times span exactly
180 seconds; the first-frame event has route offset zero. Coordinates move east
along a short synthetic line, and engagement pauses from 20 to 40 seconds of
each segment. The
metadata dates are inherited from the demo's public source route, so listing
the demo still needs its usual initial API request. No raw qlogs are supplied.

## Regenerate media

Run from the repository root with FFmpeg, libx264, and DejaVu Sans installed:

```bash
ffmpeg -f lavfi -i 'color=c=0x16181a:size=320x200:rate=5' \
  -f lavfi -i 'sine=frequency=440:sample_rate=16000' -t 180 \
  -vf "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Playback test':fontcolor=white:fontsize=24:x=(w-tw)/2:y=60,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='%{pts\\:hms}':fontcolor=white:fontsize=24:x=(w-tw)/2:y=105" \
  -c:v libx264 -profile:v baseline -pix_fmt yuv420p -preset veryfast -crf 35 \
  -g 50 -sc_threshold 0 -c:a aac -b:a 8k -af 'volume=0.08' \
  -hls_time 60 -hls_playlist_type vod \
  -hls_segment_filename '/tmp/connect-fixture-%d.ts' /tmp/connect-fixture.m3u8
for segment in 0 1 2; do
  cp "/tmp/connect-fixture-$segment.ts" "public/demo-video/$segment/qcamera.ts"
  ffmpeg -i "public/demo-video/$segment/qcamera.ts" \
    -vf 'fps=1/5,scale=128:80,tile=12x1' -frames:v 1 -q:v 14 -y \
    "public/demo-video/$segment/sprite.jpg"
done
```

Keep the checked-in manifests: the generated temporary manifest has different
relative filenames. FFmpeg versions may produce different binary encodings.
Verify three 60-second H.264 Constrained Baseline video streams and AAC-LC mono
tracks with `ffprobe`. Five video frames per second keeps the fixture small;
this is useful for playback state, seeking, and gap tests, and does not replace
testing real driving video or listening on physical iOS/Android audio devices.
