import type { RefObject } from 'react';
import { Input } from './ui/input';

interface MailPasswordFieldProps {
  id: string;
  /** O campo em si: quem usa lê o valor uma vez ao conectar e o apaga quando a chamada termina. */
  inputRef: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  /** Id do texto que explica o campo (o problema da senha, quando há). */
  describedBy?: string;
  invalid: boolean;
  /** Enter no campo: conecta (o campo vive dentro do formulário das configurações, que não deve ser enviado). */
  onSubmit: () => void;
  /** O dono voltou a digitar: o problema mostrado deixa de valer. */
  onEdit: () => void;
}

/**
 * A senha de app do Gmail. Ela abre a caixa inteira, então o campo é só de escrita, como o das chaves de IA: não é
 * controlado (o texto nunca entra em estado React), o navegador e os gerenciadores de senha não o guardam nem o
 * preenchem, e o valor só sai daqui no corpo do PUT que testa a conexão.
 */
export function MailPasswordField({ id, inputRef, disabled, describedBy, invalid, onSubmit, onEdit }: MailPasswordFieldProps) {
  return (
    <Input
      ref={inputRef} id={id} type="password" autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-bwignore="true"
      spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={disabled} data-testid="email-password"
      placeholder="xxxx xxxx xxxx xxxx" maxLength={80}
      onChange={onEdit}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        onSubmit();
      }}
      aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}
      className="font-mono tracking-wide"
    />
  );
}
