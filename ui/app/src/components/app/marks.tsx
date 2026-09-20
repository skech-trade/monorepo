/**
 * Chain and token marks.
 *
 * Drawn here rather than fetched, for the same reason the Bitcoin mark is:
 * an icon that arrives over the network is a third-party request on every
 * load, a blank square while it lands, and a broken square when it does not.
 * These are the official glyphs, simplified to what reads at twenty pixels.
 *
 * Each sets its own colours, so they look the same on either theme.
 */

type MarkProps = { className?: string };

const box = "shrink-0";

export function EthereumMark({ className }: MarkProps) {
  return (
    <svg aria-hidden="true" className={`${box} ${className ?? ""}`} viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="#627EEA" r="16" />
      <path d="M16 4.5v8.4l7.1 3.2z" fill="#fff" fillOpacity=".6" />
      <path d="M16 4.5 8.9 16.1l7.1-3.2z" fill="#fff" />
      <path d="M16 21.5v6l7.1-9.9z" fill="#fff" fillOpacity=".6" />
      <path d="M16 27.5v-6L8.9 17.6z" fill="#fff" />
      <path d="m16 20.1 7.1-4-7.1-3.2z" fill="#fff" fillOpacity=".2" />
      <path d="m8.9 16.1 7.1 4v-7.2z" fill="#fff" fillOpacity=".6" />
    </svg>
  );
}

export function BaseMark({ className }: MarkProps) {
  return (
    <svg aria-hidden="true" className={`${box} ${className ?? ""}`} viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="#0052FF" r="16" />
      {/* The mark is a circle with a flat left edge, so the counter shows. */}
      <path d="M15.9 26.5c5.9 0 10.6-4.7 10.6-10.5S21.8 5.5 15.9 5.5C10.4 5.5 5.8 9.7 5.4 15h14v2h-14c.4 5.3 5 9.5 10.5 9.5z" fill="#fff" />
    </svg>
  );
}

export function ArbitrumMark({ className }: MarkProps) {
  return (
    <svg aria-hidden="true" className={`${box} ${className ?? ""}`} viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="#213147" r="16" />
      <path d="m14.2 12.6 2.1-3.6 5.7 9.9-.1 1.9-1.9-3.2z" fill="#12AAFF" />
      <path d="m17.9 9 5.7 9.9v1.9L17.4 10z" fill="#12AAFF" />
      <path d="m16 5.8 9.4 5.4v9.6L16 26.2l-9.4-5.4v-2.2l3.5-5.7 1.3 3.3-1.6 4.4 4.3 2.5 4.2-7.3-3.6-6.3z" fill="#9DCCED" fillOpacity=".25" />
      <path d="m11.6 22.6-1.9-1.1 4.4-11.9 2.2 1.2z" fill="#fff" />
      <path d="m19.3 22.6-4.1-11.2 2-3.5 5.8 15z" fill="#fff" />
    </svg>
  );
}

export function OptimismMark({ className }: MarkProps) {
  return (
    <svg aria-hidden="true" className={`${box} ${className ?? ""}`} viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="#FF0420" r="16" />
      <path
        d="M11.2 20.6c-1.4 0-2.5-.3-3.4-1-.9-.7-1.3-1.6-1.3-2.9 0-.3 0-.6.1-1 .2-1.1.5-2.3.8-3.8.9-3.8 3.3-5.6 7.2-5.6 1.1 0 2 .2 2.9.5.8.4 1.5.9 1.9 1.6.5.7.7 1.5.7 2.5 0 .3 0 .6-.1 1-.2 1.4-.5 2.6-.8 3.8-.5 1.9-1.3 3.3-2.5 4.3-1.2.9-2.7 1.4-4.7 1.4zm.3-2.9c.8 0 1.4-.2 2-.7.5-.5.9-1.2 1.2-2.1.3-1.2.5-2.3.7-3.4 0-.3.1-.6.1-.9 0-1.2-.7-1.9-2-1.9-.8 0-1.4.2-2 .7-.5.5-.9 1.2-1.1 2.1-.2.7-.4 1.9-.7 3.4-.1.3-.1.6-.1.9 0 1.3.6 1.9 1.9 1.9z"
        fill="#fff"
      />
      <path
        d="M20.5 20.4c-.2 0-.3-.1-.3-.2v-.2l2.6-12.3c0-.1.1-.2.1-.2.1-.1.2-.1.3-.1h5c1.4 0 2.5.3 3.3.9.8.6 1.2 1.4 1.2 2.5 0 .3 0 .6-.1 1-.3 1.5-.9 2.6-1.9 3.4-1 .7-2.3 1.1-4 1.1h-2.6l-.8 4c-.1.1-.1.2-.2.2 0 .1-.1.1-.2.1h-2.4z"
        fill="#fff"
      />
    </svg>
  );
}

export function PolygonMark({ className }: MarkProps) {
  return (
    <svg aria-hidden="true" className={`${box} ${className ?? ""}`} viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="#6C00F6" r="16" />
      <path
        d="M21.4 12.3c-.4-.2-.9-.2-1.3 0l-3 1.8-2 1.1-2.9 1.8c-.4.2-.9.2-1.3 0l-2.3-1.4a1.3 1.3 0 0 1-.7-1.1v-2.7c0-.5.2-.9.7-1.1l2.3-1.3c.4-.2.9-.2 1.3 0l2.3 1.4c.4.2.6.6.6 1.1v1.8l2-1.2v-1.8c0-.4-.2-.9-.7-1.1l-4.2-2.5c-.4-.2-.9-.2-1.3 0L6.6 9.6c-.5.2-.7.6-.7 1.1v4.9c0 .5.2.9.7 1.1l4.3 2.5c.4.2.9.2 1.3 0l2.9-1.7 2-1.2 2.9-1.7c.4-.2.9-.2 1.3 0l2.3 1.3c.4.2.6.6.6 1.1v2.7c0 .4-.2.9-.6 1.1l-2.3 1.4c-.4.2-.9.2-1.3 0l-2.3-1.3a1.3 1.3 0 0 1-.7-1.1v-1.8l-2 1.2v1.8c0 .5.2.9.7 1.1l4.3 2.5c.4.2.9.2 1.3 0l4.3-2.5c.4-.2.6-.6.6-1.1v-5c0-.4-.2-.9-.6-1.1z"
        fill="#fff"
      />
    </svg>
  );
}

export function AvalancheMark({ className }: MarkProps) {
  return (
    <svg aria-hidden="true" className={`${box} ${className ?? ""}`} viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="#E84142" r="16" />
      <path
        d="M20.9 16.5c.5-.9 1.3-.9 1.8 0l3 5.3c.5.9.1 1.6-.9 1.6h-6c-1 0-1.4-.7-.9-1.6zM15.2 6.6c.5-.9 1.2-.9 1.7 0l.7 1.2c.4.7.4 1.4 0 2.1l-4.9 8.6c-.5.8-1.2 1.2-2.1 1.2H6.2c-1 0-1.4-.7-.9-1.6z"
        fill="#fff"
      />
    </svg>
  );
}

export function WorldMark({ className }: MarkProps) {
  return (
    <svg aria-hidden="true" className={`${box} ${className ?? ""}`} viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="#000" r="16" />
      {/* A globe: the outline, its equator, and a meridian bowed to one side. */}
      <circle cx="16" cy="16" fill="none" r="8.5" stroke="#fff" strokeWidth="1.6" />
      <path d="M7.5 16h17" stroke="#fff" strokeLinecap="round" strokeWidth="1.6" />
      <path d="M16 7.5c3.2 3.4 3.2 13.6 0 17" fill="none" stroke="#fff" strokeWidth="1.6" />
      <path d="M16 7.5c-3.2 3.4-3.2 13.6 0 17" fill="none" stroke="#fff" strokeWidth="1.6" />
    </svg>
  );
}

export function UsdcMark({ className }: MarkProps) {
  return (
    <svg aria-hidden="true" className={`${box} ${className ?? ""}`} viewBox="0 0 32 32">
      <circle cx="16" cy="16" fill="#2775CA" r="16" />
      <path
        d="M20.5 18.5c0-2.4-1.4-3.2-4.3-3.5-2-.3-2.4-.8-2.4-1.8 0-1 .7-1.6 2.1-1.6 1.3 0 2 .4 2.3 1.5.1.2.3.4.5.4h1.1c.3 0 .5-.2.5-.5v-.1a3.6 3.6 0 0 0-3.2-2.9V8.4c0-.3-.2-.5-.6-.6h-1c-.3 0-.5.2-.6.6V10a3.5 3.5 0 0 0-3.2 3.4c0 2.3 1.4 3.2 4.2 3.5 1.9.3 2.5.7 2.5 1.9 0 1.1-1 1.9-2.3 1.9-1.8 0-2.4-.8-2.6-1.8 0-.3-.3-.4-.5-.4h-1.1c-.3 0-.5.2-.5.5v.1c.3 1.7 1.4 2.9 3.5 3.2v1.6c0 .3.2.5.6.6h1c.3 0 .5-.2.6-.6V22a3.7 3.7 0 0 0 3.4-3.5z"
        fill="#fff"
      />
      <path
        d="M13.1 24.9a9 9 0 0 1 0-17 .6.6 0 0 0 .4-.6v-.9c0-.3-.1-.4-.4-.4h-.1a11 11 0 0 0 0 20.8h.2c.3-.1.4-.3.4-.6v-.9c0-.2-.2-.4-.5-.4zm5.9-18.9h-.2c-.3.1-.4.3-.4.6v.9c0 .3.2.5.4.6a9 9 0 0 1 0 17 .6.6 0 0 0-.4.6v.9c0 .3.1.4.4.4h.2a11 11 0 0 0 0-20.9z"
        fill="#fff"
      />
    </svg>
  );
}

const CHAIN_MARKS: Record<number, (p: MarkProps) => React.ReactElement> = {
  1: EthereumMark,
  10: OptimismMark,
  137: PolygonMark,
  480: WorldMark,
  8453: BaseMark,
  42161: ArbitrumMark,
  43114: AvalancheMark,
};

/** A chain's own mark, or a quiet disc for one we have not drawn. */
export function ChainMark({ id, className }: { id: number; className?: string }) {
  const Mark = CHAIN_MARKS[id];
  if (Mark) return <Mark className={className} />;
  return <span aria-hidden="true" className={`${box} ${className ?? ""} rounded-full bg-muted`} />;
}

/** USDC has its own mark; a chain's own coin wears the chain's. */
export function TokenMark({ chainId, native, className }: { chainId: number; native: boolean; className?: string }) {
  return native ? <ChainMark className={className} id={chainId} /> : <UsdcMark className={className} />;
}
