// Per-item one-time password display (the `806 094` + countdown in the design). Reads
// a base32 seed from the item's decrypted blob and generates the live code LOCALLY each
// second (lib/otp, RFC 6238). The seed itself is never shown or sent anywhere.
import { useEffect, useState } from 'react';

import { CheckIcon, CopyIcon } from '../../components/icons';
import { generateTotp, otpSecondsRemaining } from '../../lib/otp';

const PERIOD = 30;

export function OtpField({ secret }: { secret: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(PERIOD);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    const tick = (): void => {
      const now = Date.now();
      setRemaining(otpSecondsRemaining(now));
      void generateTotp(secret, now).then((c) => {
        if (active) {
          setCode(c);
        }
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [secret]);

  if (code === null) {
    return null; // invalid / empty seed → render nothing
  }

  const display = `${code.slice(0, 3)} ${code.slice(3)}`;
  const dash = 2 * Math.PI * 9;
  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1200);
      })
      .catch(() => undefined);
  };

  return (
    <div>
      <div className="text-[11.5px] text-muted2">One-time password</div>
      <div className="mt-1 flex items-center gap-2.5">
        <span className="font-mono text-lg font-semibold tracking-[0.12em] text-ok">{display}</span>
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="-rotate-90">
          <circle cx="10" cy="10" r="9" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
          <circle
            cx="10"
            cy="10"
            r="9"
            fill="none"
            stroke="#5bbf92"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={dash}
            strokeDashoffset={dash * (1 - remaining / PERIOD)}
            style={{ transition: 'stroke-dashoffset 1s linear' }}
          />
        </svg>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy one-time password"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted2 hover:bg-white/[0.06] hover:text-fg"
        >
          {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
        </button>
      </div>
    </div>
  );
}
