import { useEffect, useMemo } from 'react';

/** A stored 160×144 PNG screenshot, shown at native resolution. */
export function Shot({ png, label }: { png: Blob; label: string }) {
  const url = useMemo(() => URL.createObjectURL(png), [png]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img className="lcd" src={url} width={160} height={144} alt={label} />;
}
