export default function MoneyBagIcon({ className = 'w-5 h-5' }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <path d="M24 12 L28 20 L36 20 L40 12" fill="none" stroke="#3d2b1f" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M26 10 Q32 6 38 10 L36 20 L28 20 Z" fill="#2f9e5c" />
      <path d="M28 19 C14 22 8 34 12 44 C15 53 24 58 32 58 C40 58 49 53 52 44 C56 34 50 22 36 19 Z" fill="#34b46a" />
      <path d="M28 19 C14 22 8 34 12 44 C15 53 24 58 32 58 C40 58 49 53 52 44 C56 34 50 22 36 19 Z" fill="url(#moneybag-shine)" opacity="0.5" />
      <text x="32" y="42" fontFamily="Arial, sans-serif" fontSize="22" fontWeight="bold" fill="#ffd23f" textAnchor="middle">$</text>
      <defs>
        <linearGradient id="moneybag-shine" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
