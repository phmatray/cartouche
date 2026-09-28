import { useRef, type ButtonHTMLAttributes } from 'react';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'type'> & { accept?: string; multiple?: boolean; onFiles: (files: File[]) => void };

/**
 * A button that opens the file picker: a real button (keyboard, screen readers, the pad), its input hidden beside it
 * (an input inside a label or button is a control inside a control). aria-disabled also disables the picker.
 */
export function FileButton({ accept, multiple, onFiles, ...button }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" {...button} onClick={() => input.current?.click()} />
      <input ref={input} type="file" accept={accept} multiple={multiple} className="sr" tabIndex={-1} aria-hidden="true" disabled={!!button['aria-disabled']}
        onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; if (files.length) onFiles(files); }} />
    </>
  );
}
