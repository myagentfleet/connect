import { vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import Thumbnails from './thumbnails';

const screenHeight = 1000;
const screenWidth = 1600;
const gutter = 20;
const percentToOffsetMock = vi.fn();
const mockRoute = {
  offset: 1600,
  segment_numbers: Array.from(Array(4).keys()),
  segment_offsets: Array.from(Array(4).keys()).map((i) => i * 60),
};

const thumbnailBounds = {
  top: 100,
  bottom: screenHeight - (100 + 100), // top + height
  left: gutter,
  right: screenWidth - gutter,

  width: screenWidth - (gutter * 2),
  height: 100,
};

const heightWithBlackBorder = 120;

describe('timeline thumbnails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    percentToOffsetMock.mockImplementation((percent) => Math.round(percent * 30000));
  });

  it('should check the segment for every image', () => {
    render(React.createElement(Thumbnails, {
      thumbnail: thumbnailBounds,
      percentToOffset: percentToOffsetMock,
      currentRoute: mockRoute,
    }));

    expect(percentToOffsetMock.mock.calls.length).toBe(10);
    const imageEntries = screen.getAllByRole('img');
    expect(imageEntries).toHaveLength(5);

    imageEntries.forEach((entry, i) => {
      expect([...entry.classList].indexOf('thumbnailImage')).toBeGreaterThan(-1);

      const backgroundParts = entry.style.backgroundSize.split(' ');
      const height = Number(backgroundParts[1].replace('px', ''));
      expect(height).toBe(heightWithBlackBorder);
      // never stretch thumbnail images
      expect(backgroundParts[0]).toBe('auto');
    });
  });

  it('uses frames within each minute and groups only consecutive frames from the same sprite', () => {
    const offsets = [0, 5000, 55000, 59999, 60000, 65000, 125000, 3595000];
    percentToOffsetMock.mockImplementation((percent) => offsets[Math.floor(percent * offsets.length)]);
    render(React.createElement(Thumbnails, {
      thumbnail: { width: offsets.length * 160, height: 100 },
      percentToOffset: percentToOffsetMock,
      currentRoute: { ...mockRoute, url: 'https://routes.example.com/drive' },
    }));

    const expected = [
      [0, 0, 320], [0, 11, 160], [0, 11, 160],
      [1, 0, 320], [2, 1, 160], [59, 11, 160],
    ];
    const images = screen.getAllByRole('img');
    expect(percentToOffsetMock).toHaveBeenCalledTimes(offsets.length);
    expect(images).toHaveLength(expected.length);
    expected.forEach(([segment, frame, width], index) => {
      expect(images[index].style.backgroundImage).toContain(`/drive/${segment}/sprite.jpg`);
      expect(Number.parseFloat(images[index].style.backgroundPositionX)).toBeCloseTo(-frame * 160);
      expect(images[index].style.width).toBe(`${width}px`);
    });
  });

  it.each([
    ['before bounds are set', { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 }],
    ['with zero width', { width: 0, height: 100, left: 10, right: 10, top: 100, bottom: 100 }],
  ])('does not render %s', (_, thumbnail) => {
    render(React.createElement(Thumbnails, {
      thumbnail,
      percentToOffset: percentToOffsetMock,
      currentRoute: mockRoute,
    }));

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(percentToOffsetMock).not.toHaveBeenCalled();
  });

  it('renders one unstyled blank strip when no route is available', () => {
    render(React.createElement(Thumbnails, {
      thumbnail: thumbnailBounds,
      percentToOffset: percentToOffsetMock,
      currentRoute: null,
    }));

    const blank = screen.getByRole('img');
    expect(blank).toHaveClass('thumbnailImage', 'blank');
    expect(blank.style.width).toBe('1600px');
    expect(blank.style.height).toBe('100px');
    expect(blank.style.backgroundImage).toBe('');
    expect(blank.style.backgroundPositionX).toBe('');
    expect(percentToOffsetMock).toHaveBeenCalledTimes(10);
  });

});
