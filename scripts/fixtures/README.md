# Gallery media fixture

`gallery-test-pattern.mp4` is a generated two-second, silent H.264 test pattern
(320 × 180, 12 fps, YUV420P, Constrained Baseline). It contains no recorded
device footage or personal data. The gallery serves it through the actual
clip-chunk protocol, then checks decoding, advancing playback, and seeking
with the browser's real video element before capturing a paused frame.

Generate it with FFmpeg and libx264:

```sh
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i testsrc2=size=320x180:rate=12:duration=2 \
  -map_metadata -1 -an -c:v libx264 -threads 1 \
  -profile:v baseline -level 3.0 -pix_fmt yuv420p \
  -crf 32 -preset veryslow -fflags +bitexact -flags:v +bitexact \
  -movflags +faststart -y gallery-test-pattern.mp4
```

The checked-in fixture is 17,772 bytes, with SHA-256
`492749ce2778f662dfc6586f984335f792b1905a65a30abad6101fd5d05afdd9`.
Re-encoding with another FFmpeg/libx264 version may produce different bytes.
