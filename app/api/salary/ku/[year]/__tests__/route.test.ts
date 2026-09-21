import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
} from '@/tests/helpers'

// The route is wrapped in withRouteContext, which resolves auth via
// requireAuth() and the active company via getActiveCompanyId().

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// Capture what the route aggregates; the XML itself is ku10-generator's job.
vi.mock('@/lib/salary/ku/ku10-generator', () => ({
  generateKU10Xml: vi.fn().mockReturnValue('<ku10/>'),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { generateKU10Xml } from '@/lib/salary/ku/ku10-generator'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const COMPANY = { name: 'Test AB', org_number: '556123-4567' }
const SETTINGS = { company_name: 'Test AB', org_number: '556123-4567', phone: '0701234567', email: 'ku@test.se' }
const PROFILE = { full_name: 'Anna Admin', email: 'anna@test.se' }

const EMPLOYEE = {
  personnummer: 'enc',
  specification_number: 1,
  employment_start: '2024-01-01',
  employment_end: null,
}

const payslip = (lineItems: Array<{ item_type: string; amount: number }>, status = 'booked', year = 2026) => ({
  employee_id: 'emp-1',
  gross_salary: 48000,
  tax_withheld: 10050,
  tax_withheld_override: null,
  avgifter_basis: 48000,
  avgifter_basis_override: null,
  employee: EMPLOYEE,
  salary_run: { period_year: year, status },
  line_items: lineItems,
})

const CAR = { item_type: 'benefit_car', amount: 6664 }
const payment = (amount: number) => ({ item_type: 'net_deduction_benefit_payment', amount })

function authed(roster: unknown[] | null, company: unknown = COMPANY) {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({ user: mockUser as never, supabase: supabase as never, error: null })
  enqueueMany([
    { data: company }, // companies
    { data: SETTINGS }, // company_settings
    { data: PROFILE }, // profiles
    { data: roster }, // salary_run_employees
  ])
}

const call = (year = '2026') =>
  GET(createMockRequest(`/api/salary/ku/${year}`), createMockRouteParams({ year }))

const aggregated = () => vi.mocked(generateKU10Xml).mock.calls[0][1][0]

describe('GET /api/salary/ku/[year]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: {} as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const { status } = await parseJsonResponse(await call())
    expect(status).toBe(401)
  })

  it('returns 400 for an invalid year', async () => {
    authed([])
    const { status, body } = await parseJsonResponse<{ error: string }>(await call('1999'))
    expect(status).toBe(400)
    expect(body.error).toBe('Ogiltigt år')
  })

  it('returns 404 when the company is not found', async () => {
    authed([], null)
    const { status } = await parseJsonResponse(await call())
    expect(status).toBe(404)
  })

  it('returns 404 when the year has no booked runs (drafts do not count)', async () => {
    authed([payslip([CAR], 'draft')])
    const { status, body } = await parseJsonResponse<{ error: string }>(await call())
    expect(status).toBe(404)
    expect(body.error).toContain('Inga bokförda lönekörningar')
  })

  it('happy path: a car benefit with no payment is reported in full (unchanged)', async () => {
    authed([payslip([CAR]), payslip([CAR])])
    const response = await call()
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<ku10/>')
    expect(aggregated()).toMatchObject({ totalGross: 96000, totalTax: 20100, benefitCar: 13328 })
  })

  it('a fully paid benefit leaves no förmånsvärde on the kontrolluppgift', async () => {
    authed([payslip([CAR, payment(-6664)])])
    await call()
    expect(aggregated().benefitCar).toBeUndefined()
  })

  it('the reduction is per payslip: a paid month and an unpaid month sum to the unpaid value', async () => {
    authed([payslip([CAR, payment(-6664)]), payslip([CAR])])
    await call()
    expect(aggregated().benefitCar).toBe(6664)
  })

  it('an over-payment in one month never eats into another month (floors at 0 per payslip)', async () => {
    authed([payslip([CAR, payment(-9000)]), payslip([CAR])])
    await call()
    expect(aggregated().benefitCar).toBe(6664)
  })

  it('partial payment: benefit minus payment', async () => {
    authed([payslip([CAR, payment(-2000)])])
    await call()
    expect(aggregated().benefitCar).toBe(4664)
  })

  it('returns 422 instead of guessing when a payment sits next to several benefit types', async () => {
    authed([payslip([CAR, { item_type: 'benefit_meals', amount: 2480 }, payment(-2480)])])
    const { status, body } = await parseJsonResponse<{ error: string }>(await call())
    expect(status).toBe(422)
    expect(body.error).toContain('flera förmånstyper')
    expect(generateKU10Xml).not.toHaveBeenCalled()
  })
})
