export function SkeletonLine({ width = 'w-full', className = '' }) {
  return <div className={`h-3 rounded bg-gray-200 dark:bg-gray-700 animate-pulse ${width} ${className}`} />
}

export function SkeletonCard({ lines = 3 }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-5">
      <SkeletonLine width="w-1/3" className="mb-4" />
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonLine key={i} width={i % 2 === 0 ? 'w-full' : 'w-2/3'} />
        ))}
      </div>
    </div>
  )
}
