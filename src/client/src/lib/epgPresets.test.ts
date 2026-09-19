import { describe, expect, it } from 'vitest'
import { EPG_PRESETS, guideUrlsWithPreset, presetById } from './epgPresets'

describe('EPG presets', () => {
  it('are all https, because a guide is fetched by the server', () => {
    for (const preset of EPG_PRESETS) expect(preset.url.startsWith('https://')).toBe(true)
  })

  it('each carry the date they were checked, so a stale one is visible', () => {
    for (const preset of EPG_PRESETS) expect(preset.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('looks one up by id', () => {
    expect(presetById('epgshare-uk1')?.label).toContain('UK')
    expect(presetById('nope')).toBeNull()
  })

  it('appends a preset to the existing sources', () => {
    const preset = EPG_PRESETS[0]
    expect(guideUrlsWithPreset([], preset)).toEqual([preset.url])
    expect(guideUrlsWithPreset(['https://example.com/guide.xml'], preset)).toEqual([
      'https://example.com/guide.xml',
      preset.url
    ])
  })

  it('does not add the same preset twice', () => {
    const preset = EPG_PRESETS[0]
    expect(guideUrlsWithPreset([preset.url], preset)).toEqual([preset.url])
  })
})
