export interface ApplySiteCopy { label: string; login: string; how: string; warning: string | null }

const CAPTCHA = 'O formulário pode pedir captcha: a janela abre e espera você resolver.';

/** Textos que a tela de Configurações mostra para cada site de candidatura. */
export const APPLY_SITE_COPY: Record<'linkedin' | 'greenhouse' | 'lever', ApplySiteCopy> = {
  linkedin: {
    label: 'LinkedIn',
    login: 'Precisa de login',
    how: 'Só vagas com "Candidatura simplificada". As outras são puladas.',
    warning: 'O LinkedIn proíbe automação nos termos de uso e pode restringir a sua conta. O risco é seu.',
  },
  greenhouse: {
    label: 'Greenhouse',
    login: 'Sem login',
    how: 'Formulário público da vaga. Perguntas demográficas opcionais ficam em branco.',
    warning: CAPTCHA,
  },
  lever: {
    label: 'Lever',
    login: 'Sem login',
    how: 'Formulário público da vaga. O Lever lê o currículo e preenche campos; a IA sobrescreve com os dados do seu perfil.',
    warning: `${CAPTCHA} No ensaio, o arquivo do currículo chega ao Lever, mas a candidatura não é enviada.`,
  },
};

export function applySiteCopy(id: string): ApplySiteCopy {
  return (APPLY_SITE_COPY as Record<string, ApplySiteCopy | undefined>)[id] ?? { label: id, login: '', how: '', warning: null };
}
