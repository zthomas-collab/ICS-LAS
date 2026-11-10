/** HopeGrid mark: a map pin over a grid, in brand colors. Decorative (the wordmark carries the name). */
export function HopeGridMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#BDE8D2" />
      <path d="M8 1v30M16 1v30M24 1v30M1 8h30M1 16h30M1 24h30" stroke="#205C4B" strokeOpacity=".18" strokeWidth="1.2" />
      <path d="M16 6.5c-4 0-7 3-7 6.8 0 5 7 12.2 7 12.2s7-7.2 7-12.2c0-3.8-3-6.8-7-6.8z" fill="#205C4B" />
      <circle cx="16" cy="13.3" r="2.8" fill="#F0B84B" />
    </svg>
  );
}
