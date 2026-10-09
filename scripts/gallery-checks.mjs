const VIDEO_SELECTOR = '[role="dialog"] video';

export async function resetCaptureScroll(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => scrollX === 0 && scrollY === 0, { timeout: 5000 });
}

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
  await resetCaptureScroll(page);
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
      && rect.left >= Math.max(0, bounds.left) && rect.right <= Math.min(innerWidth, bounds.right)
      && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    const buttons = Array.from(group.querySelectorAll('button'));
    const speed = group.querySelector('select[aria-label="Playback speed"]');
    if (!speed) throw new Error('Playback speed selector is missing');
    const controlBounds = [...buttons, speed].map((control) => control.getBoundingClientRect());
    const orderedControls = [...controlBounds].sort((first, second) => first.left - second.left);
    const controlGaps = orderedControls.slice(1).map((control, index) => control.left - orderedControls[index].right);
    const readoutBounds = readout.getBoundingClientRect();
    const controlCentersY = controlBounds.map((rect) => (rect.top + rect.bottom) / 2);
    const controlCentersX = controlBounds.map((rect) => (rect.left + rect.right) / 2).sort((a, b) => a - b);
    const slotSpacing = controlCentersX.slice(1).map((center, index) => center - controlCentersX[index]);
    const containerWidth = group.closest('.PlaybackControlsContainer').getBoundingClientRect().width;
    const compact = containerWidth <= 380;
    const groupStyle = getComputedStyle(group);
    const innerControlWidth = bounds.width - parseFloat(groupStyle.paddingLeft) - parseFloat(groupStyle.paddingRight)
      - parseFloat(groupStyle.borderLeftWidth) - parseFloat(groupStyle.borderRightWidth);
    const roomForEqualSlots = innerControlWidth >= controlBounds.length * 52 + (controlBounds.length - 1) * 4;
    const groupCenter = (bounds.left + bounds.right) / 2;
    const speedBounds = speed.getBoundingClientRect();
    const intersects = (first, second) => first.left < second.right && first.right > second.left
      && first.top < second.bottom && first.bottom > second.top;
    const rowLayout = compact ? (
      readoutBounds.bottom <= Math.min(...controlBounds.map((rect) => rect.top))
      && Math.abs((readoutBounds.left + readoutBounds.right) / 2 - (bounds.left + bounds.right) / 2) <= 1
    ) : Math.abs((readoutBounds.top + readoutBounds.bottom) / 2 - controlCentersY[0]) <= 2;
    const video = document.querySelector('.DriveView video');
    const videoBounds = video?.getBoundingClientRect();
    return {
      width: innerWidth,
      singleLine: lines.length === 1,
      readoutFits: lines.every(within),
      groupWidth: bounds.width,
      containerWidth,
      compact,
      controlsFit: buttons.length >= 4 && controlBounds.every(within),
      touchTargets: controlBounds.every((rect) => rect.width >= 44 && rect.height >= 44),
      speedMinimumWidth: speedBounds.width >= 52,
      controlsAligned: Math.max(...controlCentersY) - Math.min(...controlCentersY) <= 1,
      controlsSeparated: controlBounds.every((control, index) => controlBounds.slice(index + 1)
        .every((other) => !intersects(control, other))),
      readoutSeparated: controlBounds.every((control) => !intersects(control, readoutBounds)),
      symmetricCompactSlots: !compact || (
        Math.abs((speedBounds.left + speedBounds.right) / 2 - groupCenter) <= 1
        && controlCentersX.every((center, index) => (
          Math.abs(center + controlCentersX[controlCentersX.length - 1 - index] - 2 * groupCenter) <= 1
        ))
      ),
      compactMinimumGaps: !compact || controlGaps.every((gap) => gap >= 3.5),
      evenCompactSlots: !compact || !roomForEqualSlots || Math.max(...slotSpacing) - Math.min(...slotSpacing) <= 2,
      roomForEqualSlots,
      rowLayout,
      slotSpacing,
      controlGaps,
      videoFits: Boolean(videoBounds && videoBounds.width > 0 && videoBounds.left >= 0 && videoBounds.right <= innerWidth),
    };
  });
  if (!result.singleLine || !result.readoutFits || !result.controlsFit || !result.touchTargets || !result.speedMinimumWidth
    || !result.controlsAligned || !result.controlsSeparated || !result.readoutSeparated
    || !result.symmetricCompactSlots || !result.compactMinimumGaps || !result.evenCompactSlots
    || !result.rowLayout || !result.videoFits) {
    throw new Error(`${label}: playback layout is clipped or misaligned: ${JSON.stringify(result)}`);
  }
  console.log(`Verified playback controls for ${label}: ${JSON.stringify(result)}`);
  const layout = await verifyDriveLayout(page, label);
  return { ...result, layout };
}

export async function verifyDriveLayout(page, label) {
  await page.hover('[role="slider"][aria-label="Drive timeline"]');
  await page.waitForSelector('[data-testid="timeline-hover-badge"]', { visible: true, timeout: 5000 });
  const result = await page.evaluate(() => {
    const rect = (element) => {
      if (!element) throw new Error('A required drive layout element is missing');
      const bounds = element.getBoundingClientRect();
      return Object.fromEntries(['left', 'right', 'top', 'bottom', 'width', 'height']
        .map((key) => [key, bounds[key]]));
    };
    const frame = document.querySelector('.DriveVideo');
    const video = frame?.querySelector('video');
    const frameBounds = rect(frame);
    const videoBounds = rect(video);
    const toolbarElement = document.querySelector('.DriveMediaToolbar');
    const toolbar = rect(toolbarElement);
    const toolbarGroups = Array.from(toolbarElement.children).map(rect)
      .filter((bounds) => bounds.width > 0 && bounds.height > 0);
    const timeline = rect(document.querySelector('[role="slider"][aria-label="Drive timeline"]'));
    const badge = rect(document.querySelector('[data-testid="timeline-hover-badge"]'));
    const controls = rect(document.querySelector('[role="group"][aria-label="Playback controls"]'));
    const intersects = (first, second) => first.left < second.right && first.right > second.left
      && first.top < second.bottom && first.bottom > second.top;
    const contains = (outer, inner) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1
      && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    const toolbarGaps = toolbarGroups.flatMap((first, index) => toolbarGroups.slice(index + 1).map((second) => {
      const sameRow = first.top < second.bottom && first.bottom > second.top;
      return {
        sameRow,
        gap: sameRow ? Math.max(second.left - first.right, first.left - second.right)
          : Math.max(second.top - first.bottom, first.top - second.bottom),
      };
    }));
    let decodedAspect = null;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      const scale = Math.min(videoBounds.width / video.videoWidth, videoBounds.height / video.videoHeight);
      const pictureWidth = video.videoWidth * scale;
      const pictureHeight = video.videoHeight * scale;
      decodedAspect = {
        intrinsicWidth: video.videoWidth,
        intrinsicHeight: video.videoHeight,
        objectFit: getComputedStyle(video).objectFit,
        frameHeightError: Math.abs(frameBounds.height - frameBounds.width * video.videoHeight / video.videoWidth),
        unusedWidth: frameBounds.width - pictureWidth,
        unusedHeight: frameBounds.height - pictureHeight,
        matches: Math.abs(frameBounds.height - frameBounds.width * video.videoHeight / video.videoWidth) <= 2
          && Math.abs(frameBounds.width - videoBounds.width) <= 2
          && Math.abs(frameBounds.height - videoBounds.height) <= 2
          && Math.abs(frameBounds.width - pictureWidth) <= 2
          && Math.abs(frameBounds.height - pictureHeight) <= 2,
      };
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, scrollY },
      media: rect(document.querySelector('.DriveMedia')),
      frame: frameBounds,
      video: videoBounds,
      toolbar,
      toolbarGroups,
      toolbarGaps,
      toolbarGroupsFit: toolbarGroups.every((bounds) => contains(toolbar, bounds)),
      toolbarGroupsSeparated: toolbarGaps.every(({ gap }) => gap >= 7.5),
      timeline,
      badge,
      controls,
      gaps: { timelineToToolbar: toolbar.top - timeline.bottom, toolbarToFrame: frameBounds.top - toolbar.bottom,
        frameToControls: controls.top - frameBounds.bottom },
      controlCenterOffset: (controls.left + controls.right - frameBounds.left - frameBounds.right) / 2,
      controlsBottomClearance: innerHeight - controls.bottom,
      desktopControlsFit: innerWidth < 768 || (controls.top >= 0 && controls.bottom <= innerHeight - 16),
      frameHasArea: frameBounds.width > 0 && frameBounds.height > 0,
      badgeWithinRuler: contains(timeline, badge),
      badgeClearsToolbar: !intersects(badge, toolbar),
      decodedAspect,
    };
  });
  const checkBadgePosition = async (fraction) => {
    await page.mouse.move(result.timeline.left + result.timeline.width * fraction,
      result.timeline.top + result.timeline.height / 2);
    return page.$eval('[data-testid="timeline-hover-badge"]', (element, { timeline, toolbar, position }) => {
      const bounds = element.getBoundingClientRect();
      return {
        position,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        withinRuler: bounds.left >= timeline.left - 1 && bounds.right <= timeline.right + 1
          && bounds.top >= timeline.top - 1 && bounds.bottom <= timeline.bottom + 1,
        clearsToolbar: bounds.right <= toolbar.left || bounds.left >= toolbar.right
          || bounds.bottom <= toolbar.top || bounds.top >= toolbar.bottom,
      };
    }, { timeline: result.timeline, toolbar: result.toolbar, position: fraction });
  };
  result.badgePositions = [
    await checkBadgePosition(0.01),
    await checkBadgePosition(0.99),
    await checkBadgePosition(0.5),
  ];
  if (!result.frameHasArea || !result.desktopControlsFit || !result.badgeWithinRuler || !result.badgeClearsToolbar
    || !result.toolbarGroupsFit || !result.toolbarGroupsSeparated
    || !result.badgePositions.every((badge) => badge.withinRuler && badge.clearsToolbar)
    || result.decodedAspect?.matches === false) {
    throw new Error(`${label}: drive aspect or spacing check failed: ${JSON.stringify(result)}`);
  }
  console.log(`Verified drive geometry for ${label}: ${JSON.stringify(result)}`);
  return result;
}
