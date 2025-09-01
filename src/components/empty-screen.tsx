import React, { useEffect, useState } from 'react';
import { UseChatHelpers } from 'ai/react';
import { Button } from './ui/button.tsx';
import { IconArrowRight } from './ui/icons.tsx';

type EmptyScreenProps = Pick<UseChatHelpers, 'setInput' | 'append'> & {
  id: string;
  setApiKey: (key: string) => void;
  // NEW: set Serper key into app state (e.g., via useLocalStorage in App.tsx)
  setSerperKey: (key: string) => void;
  // If true, the modal opens on first render when no key is present
  initialOpen?: boolean;
};

const exampleMessages = [
  {
    heading: `Which supplement may slow the progression of Alzheimer's disease`,
    message: `Which supplement may slow the progression of Alzheimer's disease?`
  },
  {
    heading: 'Which factors can trigger Alzheimer’s to get worse?',
    message: 'Which factors can trigger Alzheimer’s to get worse?'
  }
];

export function EmptyScreen({
  setInput,
  id,
  append,
  setApiKey,
  setSerperKey,
  initialOpen
}: EmptyScreenProps) {
  const [open, setOpen] = useState<boolean>(!!initialOpen);
  const [keyInput, setKeyInput] = useState<string>('');
  const [serperKeyInput, setSerperKeyInput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // keep the modal in sync if App.tsx toggles initialOpen
  useEffect(() => {
    setOpen(!!initialOpen);
  }, [initialOpen]);

  const saveKey = () => {
    // Trim + strip accidental surrounding quotes
    const k = keyInput.trim().replace(/^["']|["']$/g, '');
    const s = serperKeyInput.trim().replace(/^["']|["']$/g, '');

    // Light validations
    if (!k || k.length < 20 || !k.startsWith('sk-')) {
      setError('Please paste a valid OpenAI API key (e.g., starts with "sk-").');
      return;
    }

    // Serper keys can be hex-like or prefixed; keep validation loose
    if (!s || s.length < 10) {
      setError('Please paste a valid Serper API key.');
      return;
    }

    setError(null);
    setApiKey(k);        // App.tsx will persist via useLocalStorage
    setSerperKey(s);     // App.tsx will persist via useLocalStorage
    setOpen(false);
    setKeyInput('');
    setSerperKeyInput('');
  };

  return (
    <div className="mx-auto max-w-2xl px-4">
      <div className="flex flex-col gap-2 rounded-lg border bg-background p-8">
        <h1 className="text-lg font-semibold">Welcome to Prototype!</h1>

        <p className="mb-2 leading-normal text-muted-foreground">
          I am a chatbot who can help you construct a comprehensive understanding about objects
          of interest by providing both text and visual interactions!
          <br />
          This demo specializes in dietary supplement and related health conditions.
        </p>

        <p className="leading-normal text-muted-foreground">You can try out the following examples:</p>

        <div className="mt-4 flex flex-col items-start space-y-2">
          {exampleMessages.map((message, index) => (
            <Button
              key={index}
              variant="link"
              className="h-auto p-0 text-base"
              onClick={() => setInput(message.message)}
            >
              <IconArrowRight className="mr-2 text-muted-foreground" />
              {message.heading}
            </Button>
          ))}
        </div>

        <p className="leading-normal text-muted-foreground mt-4">
          You can also start a conversation about a specific supplement or its relation with the
          supported entity types.
        </p>

        {/* Action to open the API key modal manually */}
        <div className="mt-6 flex items-center gap-3">
          <Button variant="outline" onClick={() => setOpen(true)}>
            Set API keys
          </Button>
          <span className="text-xs text-muted-foreground">
            Your keys (OpenAI + Serper) are stored locally in your browser.
          </span>
        </div>
      </div>

      {/* Simple modal (no extra UI libs required) */}
      {open && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-lg border bg-background p-6 shadow-xl">
            <h2 className="text-base font-semibold mb-2">Enter your API keys</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Paste your OpenAI and Serper keys below. These will only be stored in your browser
              and included in each request.
            </p>

            <label htmlFor="openai-key" className="text-sm font-medium">OpenAI API key</label>
            <input
              id="openai-key"
              type="password"
              placeholder="sk-********************************"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveKey(); }}
              className="w-full rounded-md border px-3 py-2 mb-3 outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />

            <label htmlFor="serper-key" className="text-sm font-medium">Serper API key</label>
            <input
              id="serper-key"
              type="password"
              placeholder="your-serper-key"
              value={serperKeyInput}
              onChange={(e) => setSerperKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveKey(); }}
              className="w-full rounded-md border px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
            />

            {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={saveKey}>Save</Button>
            </div>

            <div className="mt-3 text-xs text-muted-foreground">
              Don’t have a key? You can create one in your OpenAI and Serper account dashboards.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
