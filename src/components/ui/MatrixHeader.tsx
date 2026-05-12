import type { ReactNode } from 'react'

interface Props {
  title: string
  subtitle: ReactNode
  legend?: boolean
}

export function MatrixHeader({ title, subtitle, legend = true }: Props) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-black/60">{subtitle}</p>
      </div>
      {legend && (
        <div className="hidden gap-3 text-xs text-black/50 md:flex">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-violet-500" />
            private
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-sky-500" />
            public
          </span>
        </div>
      )}
    </div>
  )
}
