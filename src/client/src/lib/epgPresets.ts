/**
 * Public XMLTV guides, as *verified* rather than as remembered.
 *
 * Every URL here was fetched on 2026-09-19 and returned real gzipped XMLTV — one of the well-known
 * hosts answers two of its advertised paths with a 404, another returns 200 with an empty body, and the
 * "obvious" path on a third does not exist. So this list contains what works, not what sounds right.
 *
 * **These rot.** Public guides move, retire and change their paths; a preset that 404s is worse than no
 * preset, because it looks like the app failed. Re-check before adding, and treat a failure in the
 * guide status table as the list being out of date rather than as a fault.
 */
export interface EpgPreset {
  id: string
  label: string
  url: string
  verified: string
  note: string
}

export const EPG_PRESETS: EpgPreset[] = [
  {
    id: 'epgshare-uk1',
    label: 'UK (epgshare01)',
    url: 'https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz',
    verified: '2026-09-19',
    note: '≈2.9 MB gzipped. Channel ids look like U.and.YESTERDAY+1.uk — the shape this app matches on.'
  },
  {
    id: 'epgshare-ie1',
    label: 'Ireland (epgshare01)',
    url: 'https://epgshare01.online/epgshare01/epg_ripper_IE1.xml.gz',
    verified: '2026-09-19',
    note: '≈2.5 MB. Carries the Irish feeds of several UK channels, which is why it is worth having.'
  },
  {
    id: 'epgshare-au1',
    label: 'Australia (epgshare01)',
    url: 'https://epgshare01.online/epgshare01/epg_ripper_AU1.xml.gz',
    verified: '2026-09-19',
    note: '≈4.2 MB.'
  },
  {
    id: 'mjh-sydney',
    label: 'Australia — Sydney (i.mjh.nz)',
    url: 'https://i.mjh.nz/au/Sydney/epg.xml.gz',
    verified: '2026-09-19',
    note: '≈750 kB.'
  }
]

export function presetById(id: string): EpgPreset | null {
  return EPG_PRESETS.find((preset) => preset.id === id) ?? null
}

/**
 * The external sources after adding one preset. The provider's own guide is not in this list — it is
 * added by the app itself — and duplicates are not added twice.
 */
export function guideUrlsWithPreset(existing: string[], preset: EpgPreset): string[] {
  return existing.includes(preset.url) ? existing : [...existing, preset.url]
}
