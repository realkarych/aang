import { ArtifactVersionId, FactId, RawSeq } from '@aang/contract'
import { readArtifactVersion, readFact, readRaw } from './api.js'
import { readSource } from './use-read.js'

export const factSource = readSource((key, signal) => readFact(FactId.parse(key), signal))

export const rawSource = readSource((key, signal) => readRaw(RawSeq.parse(Number(key)), signal))

export const versionSource = readSource((key, signal) => readArtifactVersion(ArtifactVersionId.parse(key), signal))
