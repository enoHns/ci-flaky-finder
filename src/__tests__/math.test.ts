import { average, stdDev, coefficientOfVariation, linearTrend, pearsonCorrelation } from '../math'

describe('average', () => {
  it('returns 0 for empty array', () => expect(average([])).toBe(0))
  it('computes correctly', () => expect(average([1, 2, 3, 4])).toBe(2.5))
})

describe('stdDev', () => {
  it('returns 0 for single value', () => expect(stdDev([5])).toBe(0))
  it('computes standard deviation', () => {
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 0)
  })
})

describe('coefficientOfVariation', () => {
  it('returns 0 when average is 0', () => expect(coefficientOfVariation([0, 0])).toBe(0))
  it('returns low CV for stable series', () => {
    expect(coefficientOfVariation([100, 101, 99, 100])).toBeLessThan(0.05)
  })
  it('returns high CV for unstable series', () => {
    expect(coefficientOfVariation([10, 100, 5, 200])).toBeGreaterThan(0.4)
  })
})

describe('linearTrend', () => {
  it('returns 0 for fewer than 3 elements', () => expect(linearTrend([1, 2])).toBe(0))
  it('detects increasing trend', () => {
    expect(linearTrend([10, 20, 30, 40, 50])).toBeGreaterThan(0.3)
  })
  it('returns near 0 for flat series', () => {
    expect(Math.abs(linearTrend([100, 100, 100, 100]))).toBeLessThan(0.01)
  })
})

describe('pearsonCorrelation', () => {
  it('returns 0 for fewer than 3 elements', () => expect(pearsonCorrelation([1, 2])).toBe(0))
  it('returns ~1 for a perfectly increasing sequence', () => {
    expect(pearsonCorrelation([10, 20, 30, 40, 50])).toBeCloseTo(1, 5)
  })
  it('returns ~-1 for a perfectly decreasing sequence', () => {
    expect(pearsonCorrelation([50, 40, 30, 20, 10])).toBeCloseTo(-1, 5)
  })
  it('returns ~0 for a flat sequence', () => {
    expect(Math.abs(pearsonCorrelation([100, 100, 100, 100]))).toBeLessThan(0.01)
  })
  it('returns ~0 for a random oscillating sequence', () => {
    expect(Math.abs(pearsonCorrelation([10, 90, 5, 95, 10, 90, 5]))).toBeLessThan(0.2)
  })
})
