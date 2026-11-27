'use client';

import { type ComponentProps, useState } from 'react';

export const verificationCodeLength = 6;

type Props = Omit<ComponentProps<'input'>, 'onChange' | 'value'> & {
  value: string;
  onCodeChange: (code: string) => void;
};

export function VerificationCode({ value, onCodeChange, ...input }: Props) {
  const [selection, setSelection] = useState([0, 0]);
  return (
    <div className="entry-code">
      {Array.from({ length: verificationCodeLength }, (_, index) => (
        <span key={index} aria-hidden="true"
          data-caret={index === Math.min(verificationCodeLength - 1, selection[0]) && selection[0] === selection[1] ? '' : undefined}
          data-selected={index >= selection[0] && index < selection[1] ? '' : undefined}>{value[index]}</span>
      ))}
      <input {...input} type="text" value={value} inputMode="numeric" autoComplete="one-time-code" spellCheck={false}
        onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, '').slice(0, verificationCodeLength))}
        onSelect={(event) => setSelection([event.currentTarget.selectionStart ?? 0, event.currentTarget.selectionEnd ?? 0])} />
    </div>
  );
}
