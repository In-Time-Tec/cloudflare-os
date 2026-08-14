import anthropicLogo from '@lobehub/icons-static-svg/icons/anthropic.svg'
import geminiLogo from '@lobehub/icons-static-svg/icons/gemini-color.svg'
import kimiLogo from '@lobehub/icons-static-svg/icons/kimi.svg'
import openAiLogo from '@lobehub/icons-static-svg/icons/openai.svg'

const MODEL_PROVIDER_LOGOS = [
  { prefix: 'openai/', src: openAiLogo, monochrome: true },
  { prefix: 'anthropic/', src: anthropicLogo, monochrome: true },
  { prefix: 'google/', src: geminiLogo, monochrome: false },
  { prefix: 'moonshotai/', src: kimiLogo, monochrome: true },
] as const

export function getModelProviderLogo(modelId: string): { src: string; monochrome: boolean } | null {
  const logo = MODEL_PROVIDER_LOGOS.find(({ prefix }) => modelId.includes(prefix))
  return logo ? { src: logo.src, monochrome: logo.monochrome } : null
}
