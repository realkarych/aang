import { type ArtifactVersionResponse, ArtifactVersionId, type Fact, FactId, type RawRecord, RawSeq } from '@aang/contract'
import { createContext, useContext } from 'react'
import { readArtifactVersion, readFact, readRaw } from './api.js'
import { type ReadSource, readSource } from './use-read.js'

export interface Generation {
  readonly ordinal: number
  readonly facts: ReadSource<Fact>
  readonly raws: ReadSource<RawRecord>
  readonly versions: ReadSource<ArtifactVersionResponse>
}

export const generationAfter = (previous: Generation | null): Generation => ({
  ordinal: previous === null ? 0 : previous.ordinal + 1,
  facts: readSource((key, signal) => readFact(FactId.parse(key), signal)),
  raws: readSource((key, signal) => readRaw(RawSeq.parse(Number(key)), signal)),
  versions: readSource((key, signal) => readArtifactVersion(ArtifactVersionId.parse(key), signal)),
})

export const GenerationContext = createContext<Generation | null>(null)

export const useGeneration = (): Generation => {
  const generation = useContext(GenerationContext)
  if (generation === null) {
    throw new Error('the data of a run is read only within the generation of its feed')
  }
  return generation
}
