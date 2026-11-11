import { parentPort, workerData } from 'node:worker_threads';
import { extractResumeText } from './extract';
import type { ResumeKind } from './sniff';

// Entrada da worker thread de `extractInWorker`: lê um arquivo e devolve o resultado por mensagem.
const { buf, kind } = workerData as { buf: Uint8Array; kind: ResumeKind };
parentPort!.postMessage(await extractResumeText(buf, kind));
