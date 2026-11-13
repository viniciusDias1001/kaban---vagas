import type { ApplicationStatus } from './apply-constants';
import type { Column, Level } from './constants';
import type { EmailKind, JobMailMarks } from './email-constants';
import type { ProfileInput } from './schemas';

export type Actor = 'ia' | 'humano' | 'sistema' | 'email';

export interface JobDto {
  id: number;
  source: string;
  externalId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  country: 'BR' | 'INT';
  remote: boolean;
  level: Level | null;
  stacks: string[];
  description: string;
  postedAt: number | null;
  discoveredAt: number;
  /** Nulo quando o perfil que encontrou a vaga foi apagado. */
  profileId: number | null;
  column: Column;
  position: number;
  appliedBy: 'ia' | 'humano' | null;
  needsHuman: boolean;
  needsHumanReason: string | null;
  notes: string;
  /** Quando a descrição foi buscada sob demanda; nulo se veio na busca ou nunca foi buscada. */
  descriptionFetchedAt: number | null;
  /** O estado da candidatura automática da vaga; nulo sem candidatura. */
  applicationStatus: ApplicationStatus | null;
  /** Marcas dos e-mails da vaga no card (`NO_MAIL_MARKS` quando não há e-mail). */
  mail: JobMailMarks;
}

/** Item de `GET /jobs` (o quadro): a vaga sem a descrição, que só vem em `GET /jobs/:id`. */
export type JobListItemDto = Omit<JobDto, 'description'>;

export interface JobEventDto {
  id: number;
  jobId: number;
  fromColumn: Column | null;
  toColumn: Column;
  actor: Actor;
  createdAt: number;
  /** O e-mail que causou o movimento (autor `email`); null nos outros eventos ou se a mensagem foi apagada. */
  mail: { kind: EmailKind | null; subject: string } | null;
}

export interface JobDetailDto {
  job: JobDto;
  events: JobEventDto[];
}

export interface ProfileDto extends ProfileInput {
  id: number;
  createdAt: number;
}

export interface SourceDto {
  id: string;
  name: string;
}

export interface SourceHealth {
  source: string;
  name: string;
  status: 'ok' | 'error' | 'never';
  found: number;
  inserted: number;
  error: string | null;
  finishedAt: number | null;
}

export interface HealthDto {
  sources: SourceHealth[];
  lastFinishedAt: number | null;
}

export interface StatsDto {
  total: number;
  appliedByAi: number;
  appliedByHuman: number;
  needsHuman: number;
}
