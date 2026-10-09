import { getSegmentNumber } from '../../utils';
import { api } from '../../api/backend';

export default function Thumbnails(props) {
  const { thumbnail, currentRoute: route } = props;
  const imgStyles = {
    display: 'inline-block',
    height: thumbnail.height,
    width: (128 / 80) * thumbnail.height,
  };
  const imgCount = Math.ceil(thumbnail.width / imgStyles.width);
  if (!Number.isFinite(imgCount)) return [];

  const images = [];
  for (let i = 0; i < imgCount; ++i) {
    const offset = props.percentToOffset((i + 0.5) / imgCount);
    const segmentNum = getSegmentNumber(route, offset);
    const seconds = Math.floor(offset / 1000);
    // Each segment's sprite contains twelve frames, five seconds apart.
    const imageIndex = Math.max(0, Math.min(Math.floor((seconds % 60) / 5), 11));
    const previous = images[images.length - 1];
    if (previous && (!route || (previous.segmentNum === segmentNum && imageIndex === previous.endImage + 1))) {
      previous.endImage = imageIndex;
      previous.length += 1;
    } else {
      images.push({ segmentNum, startImage: imageIndex, endImage: imageIndex, length: 1 });
    }
  }

  return images.map((data, i) => (
    <div
      key={i}
      className={`thumbnailImage ${route ? 'images' : 'blank'}`}
      role="img"
      style={{
        ...imgStyles,
        width: imgStyles.width * data.length,
        ...(route ? {
          backgroundSize: `auto ${imgStyles.height * 1.2}px`,
          backgroundRepeat: 'repeat-x',
          backgroundImage: `url(${api.routeAssets.thumbnail(route, data.segmentNum)})`,
          backgroundPositionX: `-${data.startImage * imgStyles.width}px`,
        } : {}),
      }}
    />
  ));
}
