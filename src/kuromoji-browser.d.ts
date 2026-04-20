declare module 'kuromoji/build/kuromoji.js' {
  import type { IpadicFeatures, TokenizerBuilderOption, TokenizerBuilder } from 'kuromoji'

  const kuromoji: {
    builder(option: TokenizerBuilderOption): TokenizerBuilder<IpadicFeatures>
  }

  export default kuromoji
}
