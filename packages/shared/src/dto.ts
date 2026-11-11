import type { Column, Level, ProfileInput } from './schemas';

export type Actor = 'ia' | 'humano' | 'sistema';

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
}

export interface JobEventDto {
  id: number;
  jobId: number;
  fromColumn: Column | null;
  toColumn: Column;
  actor: Actor;
  createdAt: number;
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
