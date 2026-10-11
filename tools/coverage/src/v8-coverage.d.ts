declare module '@bcoe/v8-coverage' {
  export interface RangeCov {
    startOffset: number
    endOffset: number
    count: number
  }

  export interface FunctionCov {
    functionName: string
    ranges: RangeCov[]
    isBlockCoverage: boolean
  }

  export interface ScriptCov {
    scriptId: string
    url: string
    functions: FunctionCov[]
  }

  export interface ProcessCov {
    result: ScriptCov[]
  }

  export function mergeProcessCovs(processCovs: ProcessCov[]): ProcessCov
}
