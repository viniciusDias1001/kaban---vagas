import { arbeitnow } from './arbeitnow';
import { fake } from './fake';
import { greenhouse } from './greenhouse';
import { gupy } from './gupy';
import { himalayas } from './himalayas';
import { indeed } from './indeed';
import { lever } from './lever';
import { linkedin } from './linkedin';
import { remoteok } from './remoteok';
import { remotive } from './remotive';
import type { Connector } from './types';

export type { Connector, ConnectorConfig } from './types';
export {
  MAX_DESCRIPTION_CHARS, createDescriptionFetcher, fetchJobDescription, type DescriptionFetcher, type DetailJob,
} from './detail';
export { LINKEDIN_MIN_INTERVAL_MS, createLane, linkedinLane, type Lane, type LaneOptions } from './lane';
export { detectLevel, detectLevels, detectStacks, matchesFilters } from './filter';

const REAL: Connector[] = [gupy, remotive, remoteok, greenhouse, lever, arbeitnow, himalayas, linkedin, indeed];

export function getConnectors(): Connector[] {
  return process.env.FAKE_CONNECTORS === '1' ? [fake] : REAL;
}

export function getConnector(id: string): Connector | undefined {
  return getConnectors().find((c) => c.id === id);
}
