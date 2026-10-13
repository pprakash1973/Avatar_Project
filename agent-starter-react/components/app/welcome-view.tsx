import { useEffect, useState } from 'react';
import { CircleNotchIcon } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import { LANGUAGES, type LanguageCode, STYLES, type StyleCode } from '@/lib/agent-channels';
import { cn } from '@/lib/shadcn/utils';
import { getSavedName, saveAdapt, saveLanguage, saveName, saveStyle } from '@/lib/visitor';

interface ChoiceGroupProps<T extends string> {
  legend: string;
  options: readonly { code: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

function ChoiceGroup<T extends string>({ legend, options, value, onChange }: ChoiceGroupProps<T>) {
  return (
    <div className="flex flex-col items-center">
      <p className="text-muted-foreground mb-2 text-xs">{legend}</p>
      <div
        role="group"
        aria-label={legend}
        className="border-input flex flex-wrap justify-center gap-1 rounded-3xl border p-1"
      >
        {options.map(({ code, label }) => (
          <button
            key={code}
            type="button"
            aria-pressed={value === code}
            onClick={() => onChange(code)}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
              value === code
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function WelcomeImage() {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-fg0 mb-4 size-16"
    >
      <path
        d="M15 24V40C15 40.7957 14.6839 41.5587 14.1213 42.1213C13.5587 42.6839 12.7956 43 12 43C11.2044 43 10.4413 42.6839 9.87868 42.1213C9.31607 41.5587 9 40.7957 9 40V24C9 23.2044 9.31607 22.4413 9.87868 21.8787C10.4413 21.3161 11.2044 21 12 21C12.7956 21 13.5587 21.3161 14.1213 21.8787C14.6839 22.4413 15 23.2044 15 24ZM22 5C21.2044 5 20.4413 5.31607 19.8787 5.87868C19.3161 6.44129 19 7.20435 19 8V56C19 56.7957 19.3161 57.5587 19.8787 58.1213C20.4413 58.6839 21.2044 59 22 59C22.7956 59 23.5587 58.6839 24.1213 58.1213C24.6839 57.5587 25 56.7957 25 56V8C25 7.20435 24.6839 6.44129 24.1213 5.87868C23.5587 5.31607 22.7956 5 22 5ZM32 13C31.2044 13 30.4413 13.3161 29.8787 13.8787C29.3161 14.4413 29 15.2044 29 16V48C29 48.7957 29.3161 49.5587 29.8787 50.1213C30.4413 50.6839 31.2044 51 32 51C32.7956 51 33.5587 50.6839 34.1213 50.1213C34.6839 49.5587 35 48.7957 35 48V16C35 15.2044 34.6839 14.4413 34.1213 13.8787C33.5587 13.3161 32.7956 13 32 13ZM42 21C41.2043 21 40.4413 21.3161 39.8787 21.8787C39.3161 22.4413 39 23.2044 39 24V40C39 40.7957 39.3161 41.5587 39.8787 42.1213C40.4413 42.6839 41.2043 43 42 43C42.7957 43 43.5587 42.6839 44.1213 42.1213C44.6839 41.5587 45 40.7957 45 40V24C45 23.2044 44.6839 22.4413 44.1213 21.8787C43.5587 21.3161 42.7957 21 42 21ZM52 17C51.2043 17 50.4413 17.3161 49.8787 17.8787C49.3161 18.4413 49 19.2044 49 20V44C49 44.7957 49.3161 45.5587 49.8787 46.1213C50.4413 46.6839 51.2043 47 52 47C52.7957 47 53.5587 46.6839 54.1213 46.1213C54.6839 45.5587 55 44.7957 55 44V20C55 19.2044 54.6839 18.4413 54.1213 17.8787C53.5587 17.3161 52.7957 17 52 17Z"
        fill="currentColor"
      />
    </svg>
  );
}

interface WelcomeViewProps {
  startButtonText: string;
  onStartCall: () => void;
  userName: string;
  onUserNameChange: (name: string) => void;
  language: LanguageCode;
  onLanguageChange: (language: LanguageCode) => void;
  style: StyleCode;
  onStyleChange: (style: StyleCode) => void;
  adaptToMood: boolean;
  onAdaptToMoodChange: (adapt: boolean) => void;
  isStarting: boolean;
}

export const WelcomeView = ({
  startButtonText,
  onStartCall,
  userName,
  onUserNameChange,
  language,
  onLanguageChange,
  style,
  onStyleChange,
  adaptToMood,
  onAdaptToMoodChange,
  isStarting,
  ref,
}: React.ComponentProps<'div'> & WelcomeViewProps) => {
  const [nameInput, setNameInput] = useState(userName);

  // Prefill the name a returning visitor used last time.
  useEffect(() => {
    setNameInput((current) => current || getSavedName());
  }, []);

  const handleSubmitName = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = nameInput.trim();
    if (name) {
      saveName(name);
      onUserNameChange(name);
    }
  };

  const handleLanguageChange = (code: LanguageCode) => {
    saveLanguage(code);
    onLanguageChange(code);
  };

  const handleStyleChange = (code: StyleCode) => {
    saveStyle(code);
    onStyleChange(code);
  };

  const handleAdaptChange = (adapt: boolean) => {
    saveAdapt(adapt);
    onAdaptToMoodChange(adapt);
  };

  return (
    <div ref={ref}>
      <section className="bg-background flex flex-col items-center justify-center px-4 text-center">
        <WelcomeImage />

        {!userName ? (
          <form onSubmit={handleSubmitName} className="flex w-full max-w-xs flex-col items-center">
            <label htmlFor="user-name" className="text-foreground pt-1 leading-6 font-medium">
              Enter your name
            </label>
            <input
              id="user-name"
              type="text"
              autoFocus
              autoComplete="given-name"
              maxLength={50}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Your name"
              className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring mt-4 h-10 w-64 rounded-full border px-4 text-center text-sm outline-none focus-visible:ring-2"
            />
            <Button
              type="submit"
              size="lg"
              disabled={!nameInput.trim()}
              className="mt-4 w-64 rounded-full font-mono text-xs font-bold tracking-wider uppercase"
            >
              Submit
            </Button>
          </form>
        ) : (
          <>
            <p className="text-foreground max-w-prose pt-1 leading-6 font-medium">
              Hi {userName}, chat live with your voice AI assistant
            </p>

            <fieldset
              className="mt-5 flex max-w-md flex-col items-center gap-4"
              disabled={isStarting}
            >
              <legend className="sr-only">Call settings</legend>
              <ChoiceGroup
                legend="Language"
                options={LANGUAGES}
                value={language}
                onChange={handleLanguageChange}
              />
              <ChoiceGroup
                legend="Style"
                options={STYLES}
                value={style}
                onChange={handleStyleChange}
              />
              <label className="text-muted-foreground flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={adaptToMood}
                  onChange={(e) => handleAdaptChange(e.target.checked)}
                  className="accent-primary size-4"
                />
                Adapt to my mood (shorter when I&apos;m in a hurry, step by step when I&apos;m
                stuck)
              </label>
            </fieldset>

            <Button
              size="lg"
              onClick={onStartCall}
              disabled={isStarting}
              aria-busy={isStarting}
              className="mt-5 w-64 rounded-full font-mono text-xs font-bold tracking-wider uppercase"
            >
              {isStarting ? (
                <>
                  <CircleNotchIcon weight="bold" className="size-4 animate-spin" />
                  Loading avatar…
                </>
              ) : (
                startButtonText
              )}
            </Button>
          </>
        )}
      </section>

      <div className="fixed bottom-5 left-0 flex w-full items-center justify-center">
        <p className="text-muted-foreground max-w-prose pt-1 text-xs leading-5 font-normal text-pretty md:text-sm">
          Need help getting set up? Check out the{' '}
          <a
            target="_blank"
            rel="noopener noreferrer"
            href="https://docs.livekit.io/agents/start/voice-ai/"
            className="underline"
          >
            Voice AI quickstart
          </a>
          .
        </p>
      </div>
    </div>
  );
};
