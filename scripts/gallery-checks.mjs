const VIDEO_SELECTOR = '[role="dialog"] video';

export async function verifyClipPlayback(page, label) {
  await page.waitForFunction((selector) => {
    const video = document.querySelector(selector);
    if (video?.error) throw new Error(`Clip media error ${video.error.code}: ${video.error.message}`);
    return video?.readyState >= 2 && video.videoWidth === 320 && video.videoHeight === 180;
  }, { timeout: 5000 }, VIDEO_SELECTOR);

  await page.evaluate(async (selector) => {
    const video = document.querySelector(selector);
    video.pause();
    video.currentTime = 0;
    await video.play();
  }, VIDEO_SELECTOR);
  await page.waitForFunction((selector) => {
    const video = document.querySelector(selector);
    if (video.error) throw new Error(`Clip playback error ${video.error.code}`);
    return !video.paused && video.currentTime >= 0.25
      && video.getVideoPlaybackQuality().totalVideoFrames >= 2;
  }, { timeout: 5000 }, VIDEO_SELECTOR);

  const played = await page.evaluate((selector) => {
    const video = document.querySelector(selector);
    video.pause();
    return {
      duration: video.duration,
      playedTo: video.currentTime,
      decodedFrames: video.getVideoPlaybackQuality().totalVideoFrames,
    };
  }, VIDEO_SELECTOR);
  if (Math.abs(played.duration - 2) > 0.05) throw new Error(`${label}: unexpected clip duration ${played.duration}`);

  await page.evaluate((selector) => { document.querySelector(selector).currentTime = 1; }, VIDEO_SELECTOR);
  await page.waitForFunction((selector) => {
    const video = document.querySelector(selector);
    return !video.error && !video.seeking && video.readyState >= 2
      && video.paused && Math.abs(video.currentTime - 1) < 0.05;
  }, { timeout: 5000 }, VIDEO_SELECTOR);
  console.log(`Verified clip decoding, playback and seek for ${label}: ${JSON.stringify(played)}`);
}

export async function verifyPlaybackControls(page, label) {
  const result = await page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="Playback controls"]');
    if (!group) throw new Error('Playback controls group is missing');
    const readout = Array.from(group.querySelectorAll('span')).find((element) => (
      /^\d{2}:\d{2}:\d{2}(?:\s+–\s+\d+)?$/.test(element.textContent)
    ));
    if (!readout) throw new Error('Playback time is missing');
    const range = document.createRange();
    range.selectNodeContents(readout);
    const lines = Array.from(range.getClientRects()).filter((rect) => rect.width > 0);
    const bounds = group.getBoundingClientRect();
    const within = (rect) => rect.width > 0 && rect.height > 0
      && rect.left >= 0 && rect.right <= innerWidth
      && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    const buttons = Array.from(group.querySelectorAll('button'));
    return {
      width: innerWidth,
      singleLine: lines.length === 1,
      readoutFits: lines.every(within),
      controlsFit: buttons.length >= 5 && buttons.every((button) => within(button.getBoundingClientRect())),
    };
  });
  if (!result.singleLine || !result.readoutFits || !result.controlsFit) {
    throw new Error(`${label}: playback controls overflow or wrap: ${JSON.stringify(result)}`);
  }
  console.log(`Verified playback controls for ${label}: ${JSON.stringify(result)}`);
}
