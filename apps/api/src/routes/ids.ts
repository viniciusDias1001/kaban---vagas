const INT4_MAX = 2_147_483_647;

/**
 * Converte um id vindo da URL/corpo. Devolve null para qualquer coisa que não caiba numa coluna
 * `integer` do Postgres ("abc", 1.5, 99999999999) — o chamador responde "não encontrado" em vez de
 * deixar o banco rejeitar o parâmetro com erro 500.
 */
export function parseId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= INT4_MAX ? n : null;
}

export const idParam = (req: { params: unknown }) => parseId((req.params as { id?: string }).id);
