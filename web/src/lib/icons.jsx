/**
 * Inline stroke SVG on a 20px grid, 1.4–1.6 stroke (design/README.md).
 * Never emoji.
 */
const S = ({ size = 18, stroke = 'currentColor', width = 1.5, children, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    stroke={stroke}
    strokeWidth={width}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
);

export const IconImage = (p) => (
  <S {...p}>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
    <circle cx="7" cy="8" r="1.4" />
    <path d="M2.5 13.5l4-3.5 3.5 3 3-2.5 4 3.5" />
  </S>
);

export const IconLaptop = (p) => (
  <S {...p}>
    <rect x="3" y="4" width="14" height="9.5" rx="1.5" />
    <path d="M1.5 16.5h17" />
  </S>
);

export const IconPhone = (p) => (
  <S {...p}>
    <rect x="5.5" y="2.5" width="9" height="15" rx="2" />
    <path d="M8.75 15.25h2.5" />
  </S>
);

export const IconTablet = (p) => (
  <S {...p}>
    <rect x="4" y="2.5" width="12" height="15" rx="2" />
    <path d="M8.75 15.25h2.5" />
  </S>
);

export const IconTerminal = (p) => (
  <S {...p}>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
    <path d="M6 8l2.25 2L6 12M10.5 12.5h3.5" />
  </S>
);

export const IconBrowser = (p) => (
  <S {...p}>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M2.9 7.75h14.2M2.9 12.25h14.2" />
    <path d="M10 2.75c-2 2.1-3 4.6-3 7.25s1 5.15 3 7.25c2-2.1 3-4.6 3-7.25s-1-5.15-3-7.25z" />
  </S>
);

export const IconAllDevices = (p) => (
  <S {...p}>
    <circle cx="10" cy="10" r="2.25" />
    <path d="M10 2.5v2.4M10 15.1v2.4M2.5 10h2.4M15.1 10h2.4M4.7 4.7l1.7 1.7M13.6 13.6l1.7 1.7M15.3 4.7l-1.7 1.7M6.4 13.6l-1.7 1.7" />
  </S>
);

export const IconSearch = (p) => (
  <S width={1.6} {...p}>
    <circle cx="8.75" cy="8.75" r="5.5" />
    <path d="M12.9 12.9l3.6 3.6" />
  </S>
);

export const IconCheck = (p) => (
  <S width={2} {...p}>
    <path d="M4 10.5l4 4 8-9" />
  </S>
);

export const IconClock = (p) => (
  <S {...p}>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M10 6v4.25l2.75 1.6" />
  </S>
);

export const IconSend = (p) => (
  <S width={1.6} {...p}>
    <path d="M10 15.5V4.5" />
    <path d="M5.75 8.75L10 4.5l4.25 4.25" />
  </S>
);

export const IconArriving = (p) => (
  <S {...p}>
    <path d="M10 4.5v9" />
    <path d="M6.5 10L10 13.5 13.5 10" />
  </S>
);

export const IconChevron = (p) => (
  <S width={2} {...p}>
    <path d="M5.5 8l4.5 4.5L14.5 8" />
  </S>
);

export const IconText = (p) => (
  <S {...p}>
    <path d="M4.5 6.5h11M4.5 10h11M4.5 13.5h7" />
  </S>
);

export const IconLink = (p) => (
  <S {...p}>
    <path d="M8.5 11.5a3 3 0 004.2 0l2.6-2.6a3 3 0 00-4.2-4.2l-.7.7" />
    <path d="M11.5 8.5a3 3 0 00-4.2 0l-2.6 2.6a3 3 0 004.2 4.2l.7-.7" />
  </S>
);

export const IconVideo = (p) => (
  <S {...p}>
    <rect x="2.5" y="4.5" width="11" height="11" rx="2" />
    <path d="M13.5 9l4-2.5v7L13.5 11z" />
  </S>
);

export const IconDoc = (p) => (
  <S {...p}>
    <path d="M5 2.5h6.5L15 6v11.5H5z" />
    <path d="M11.5 2.5V6H15" />
  </S>
);

export const IconGear = (p) => (
  <S {...p}>
    <circle cx="10" cy="10" r="2.6" />
    <path d="M15.7 12.1a1.3 1.3 0 00.26 1.43l.05.05a1.55 1.55 0 11-2.2 2.2l-.05-.05a1.3 1.3 0 00-1.43-.26 1.3 1.3 0 00-.79 1.19v.13a1.55 1.55 0 11-3.1 0v-.07a1.3 1.3 0 00-.85-1.19 1.3 1.3 0 00-1.43.26l-.05.05a1.55 1.55 0 11-2.2-2.2l.05-.05a1.3 1.3 0 00.26-1.43 1.3 1.3 0 00-1.19-.79H2.9a1.55 1.55 0 110-3.1h.07a1.3 1.3 0 001.19-.85 1.3 1.3 0 00-.26-1.43l-.05-.05a1.55 1.55 0 112.2-2.2l.05.05a1.3 1.3 0 001.43.26h.06a1.3 1.3 0 00.79-1.19V2.9a1.55 1.55 0 113.1 0v.07a1.3 1.3 0 00.79 1.19 1.3 1.3 0 001.43-.26l.05-.05a1.55 1.55 0 112.2 2.2l-.05.05a1.3 1.3 0 00-.26 1.43v.06a1.3 1.3 0 001.19.79h.13a1.55 1.55 0 110 3.1h-.07a1.3 1.3 0 00-1.19.79z" />
  </S>
);

export const IconX = (p) => (
  <S width={1.6} {...p}>
    <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
  </S>
);

export const IconCopy = (p) => (
  <S {...p}>
    <rect x="7" y="7" width="9.5" height="9.5" rx="1.8" />
    <path d="M13 4.5a1.8 1.8 0 00-1.8-1.8H5.3A1.8 1.8 0 003.5 4.5v5.9A1.8 1.8 0 005.3 12.2" />
  </S>
);

export const IconPlug = (p) => (
  <S {...p}>
    <path d="M3 3l14 14" />
    <path d="M13.5 6.5A4.5 4.5 0 0116 10.4M6.5 6.6A4.5 4.5 0 004 10.4" />
    <path d="M10 14.5v2.5" />
    <circle cx="10" cy="10.5" r="1" />
  </S>
);

export const IconInbox = (p) => (
  <S {...p}>
    <path d="M2.75 11.5h3.5l1.2 2h5.1l1.2-2h3.5" />
    <path d="M4.6 4.2h10.8l1.85 7.3v3.1a1.5 1.5 0 01-1.5 1.5H4.25a1.5 1.5 0 01-1.5-1.5v-3.1z" />
  </S>
);

/** Pick the row glyph for a transfer. */
export function kindIcon(t) {
  if (t.kind === 'link') return IconLink;
  if (t.kind === 'text') return IconText;
  const mime = t.mime_type || '';
  if (mime.startsWith('image/')) return IconImage;
  if (mime.startsWith('video/')) return IconVideo;
  return IconDoc;
}

/** Pick the glyph for a device platform. */
export function platformIcon(platform) {
  return {
    ios: IconPhone,
    android: IconPhone,
    macos: IconLaptop,
    web: IconBrowser,
    cli: IconTerminal,
  }[platform] || IconLaptop;
}
