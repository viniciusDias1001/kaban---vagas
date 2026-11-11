import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { springSnap } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { fieldClass } from './input';

interface TagInputProps {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
  /** Texto ainda não confirmado. Quem usa o campo deve contá-lo junto com as tags ao enviar. */
  draft: string;
  onDraftChange: (draft: string) => void;
  placeholder?: string;
  id?: string;
}

const clean = (raw: string) => raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/** Campo de tags: Enter ou vírgula confirma, Backspace no campo vazio remove a última. */
function TagInput({ tags, onTagsChange, draft, onDraftChange, placeholder, id }: TagInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const add = (raw: string) => {
    const next = clean(raw).filter((t) => !tags.includes(t));
    if (next.length > 0) onTagsChange([...tags, ...new Set(next)]);
    onDraftChange('');
  };

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'Enter' || e.key === ',') && draft.trim() !== '') {
      e.preventDefault(); // com texto pendente, Enter vira tag em vez de enviar o formulário
      add(draft);
    } else if (e.key === ',') {
      e.preventDefault();
    } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
      onTagsChange(tags.slice(0, -1));
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (!text.includes(',')) return;
    e.preventDefault();
    add(draft + text);
  }

  return (
    <div
      data-slot="tag-input"
      onClick={() => input.current?.focus()}
      className={cn(
        fieldClass,
        'flex min-h-10 cursor-text flex-wrap items-center gap-1.5 px-2 py-1.5',
        'focus-within:border-accent focus-within:bg-bg/80 focus-within:ring-[3px] focus-within:ring-accent/25',
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        {tags.map((t) => (
          <motion.span
            key={t} layout
            initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}
            transition={springSnap}
            className="inline-flex h-6 items-center gap-0.5 rounded-lg bg-accent/15 pl-2 pr-0.5 text-xs font-medium text-accent ring-1 ring-inset ring-accent/25"
          >
            {t}
            <button
              type="button" aria-label={`Remover ${t}`}
              onClick={(e) => { e.stopPropagation(); onTagsChange(tags.filter((x) => x !== t)); }}
              className="grid size-5 cursor-pointer place-items-center rounded-md text-accent/70 transition-colors hover:bg-accent/20 hover:text-ink"
            >
              <X aria-hidden className="size-3" strokeWidth={3} />
            </button>
          </motion.span>
        ))}
      </AnimatePresence>
      <input
        ref={input} id={id} value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKeyDown} onPaste={onPaste}
        onBlur={() => draft.trim() !== '' && add(draft)}
        placeholder={tags.length === 0 ? placeholder : undefined}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm text-ink outline-none placeholder:text-faint"
      />
    </div>
  );
}

export { TagInput };
