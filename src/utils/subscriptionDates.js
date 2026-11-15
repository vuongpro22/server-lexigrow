export function renewalEndDate(startDate, previousEndDate, durationDays) {
  const previous = previousEndDate ? new Date(previousEndDate) : null
  const base = previous && previous > startDate ? previous : startDate
  return new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000)
}
