import { getModelProviderLogo } from '../modelProviderLogo'

export default function ModelProviderMark({
  modelId,
  name,
  size = 14,
}: {
  modelId: string
  name: string
  size?: number
}) {
  const logo = getModelProviderLogo(modelId)
  if (logo) {
    return (
      <img
        src={logo.src}
        alt=""
        width={size}
        height={size}
        className={`shrink-0 object-contain ${logo.monochrome ? 'dark:invert' : ''}`}
      />
    )
  }
  return (
    <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-[10px] font-medium text-kumo-subtle">
      {name[0]?.toUpperCase() ?? '?'}
    </span>
  )
}
