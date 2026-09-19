import { describe, expect, it } from 'vitest'
import { displaySourceUrl, sourceLabel, sourceUrlWithoutCredentials } from './sourceLabel'

describe('guide source labels', () => {
  it('shows an external source in full — it used to be cut at 65 characters', () => {
    const long = 'https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz?with=averylongquerystringindeed'
    expect(displaySourceUrl(long, 'external')).toBe(long)
  })

  it('names the provider guide rather than showing it', () => {
    expect(displaySourceUrl('https://host/xmltv.php?username=u&password=p', 'provider')).toBe('Provider guide')
    expect(sourceLabel('https://host/xmltv.php?username=u&password=p', 'provider')).toBe('Provider guide')
  })

  it('never shows a query string', () => {
    const withSecret = 'https://primehub.example/xmltv.php?username=glustick&password=hunter2'
    expect(sourceUrlWithoutCredentials(withSecret)).toBe('https://primehub.example/xmltv.php')
    expect(sourceUrlWithoutCredentials(withSecret)).not.toContain('hunter2')
  })

  it('copes with something that is not a URL', () => {
    expect(sourceUrlWithoutCredentials('not a url?x=1')).toBe('not a url')
    expect(sourceLabel('weird', null)).toBe('weird')
  })
})
