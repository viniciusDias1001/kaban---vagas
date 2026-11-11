/**
 * Estado das notas de UMA vaga, fora do React (para sobreviver ao fechamento do painel e ser testável sem DOM).
 *
 * Regras:
 * - o texto do servidor entra uma única vez (`seed`); refetches posteriores nunca sobrescrevem o campo;
 * - `edit` marca o campo como sujo; `flush` (blur, fechar o painel, "tentar de novo") salva se estiver sujo;
 * - se o usuário digita enquanto um salvamento está em andamento, o texto novo é salvo em seguida;
 * - se o salvamento falha, o texto fica, o erro aparece e `flush` tenta de novo.
 */
export type NotesStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface NotesSnapshot {
  text: string;
  status: NotesStatus;
  /** Mensagem do último salvamento que falhou (status `error`). */
  error: string | null;
  /** Há texto que o servidor ainda não tem. */
  dirty: boolean;
  /** Já recebeu o texto do servidor (antes disso o campo não deve aparecer). */
  seeded: boolean;
}

export interface NotesOptions {
  save: (text: string) => Promise<unknown>;
  maxLength: number;
  /** Falha ao salvar sem ninguém olhando (painel já fechado): hora de avisar por outro meio. */
  onDetachedError?: (message: string) => void;
}

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Não foi possível salvar as notas.');

export class NotesController {
  private text = '';
  private saved = '';
  private status: NotesStatus = 'idle';
  private error: string | null = null;
  private seeded = false;
  private again = false;
  private inFlight: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: NotesSnapshot;

  constructor(private readonly options: NotesOptions) {
    this.snapshot = this.build();
  }

  private build(): NotesSnapshot {
    return { text: this.text, status: this.status, error: this.error, dirty: this.text !== this.saved, seeded: this.seeded };
  }

  private emit() {
    this.snapshot = this.build();
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): NotesSnapshot => this.snapshot;

  /** Nada pendente: pode ser descartado sem perder texto. */
  get settled(): boolean {
    return this.text === this.saved && this.inFlight === null;
  }

  /** Texto vindo do servidor. Só vale na primeira vez: depois disso quem manda é o campo. */
  seed(serverText: string) {
    if (this.seeded) return;
    this.seeded = true;
    this.text = serverText;
    this.saved = serverText;
    this.emit();
  }

  edit(text: string) {
    const next = text.slice(0, this.options.maxLength);
    if (next === this.text) return;
    this.text = next;
    // Voltou ao que está salvo: não há mais o que tentar de novo.
    if (this.status === 'error' && next === this.saved) {
      this.status = 'idle';
      this.error = null;
    }
    this.emit();
  }

  /** Salva se houver algo não salvo. Chamado no blur, ao fechar o painel e no "Tentar de novo". */
  flush(): Promise<void> {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    if (this.text === this.saved) return Promise.resolve();
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
      this.emit();
    });
    return this.inFlight;
  }

  private async run() {
    do {
      this.again = false;
      const sending = this.text;
      this.status = 'saving';
      this.error = null;
      this.emit();
      try {
        await this.options.save(sending);
        this.saved = sending;
        this.status = 'saved';
        this.emit();
      } catch (e) {
        this.status = 'error';
        this.error = messageOf(e);
        this.emit();
        if (this.listeners.size === 0) this.options.onDetachedError?.(this.error);
        return;
      }
    } while (this.again && this.text !== this.saved);
  }
}

/**
 * Controladores com algo pendente (texto não salvo, salvamento em andamento ou que falhou), por vaga.
 * É o que mantém o texto quando o painel fecha antes de o salvamento terminar ou depois de ele falhar:
 * ao reabrir a vaga, o mesmo controlador (com o texto digitado) volta para o campo.
 */
export class NotesStore {
  private readonly byJob = new Map<number, NotesController>();

  acquire(jobId: number, create: () => NotesController): NotesController {
    let controller = this.byJob.get(jobId);
    if (!controller) {
      controller = create();
      this.byJob.set(jobId, controller);
    }
    return controller;
  }

  /**
   * Chamado quando o painel solta o controlador: se não há mais nada pendente ele sai da memória; se há
   * (texto não salvo, salvamento em andamento ou que falhou), fica guardado para a próxima abertura da vaga.
   */
  release(jobId: number, controller: NotesController | undefined = this.byJob.get(jobId)) {
    if (!controller) return;
    if (!controller.settled) this.byJob.set(jobId, controller);
    else if (this.byJob.get(jobId) === controller) this.byJob.delete(jobId);
  }

  has(jobId: number) {
    return this.byJob.has(jobId);
  }
}
