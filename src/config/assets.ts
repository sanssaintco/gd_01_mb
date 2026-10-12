// Asset URLs. The files are in public/, which Vite serves at the base URL and copies into the
// build. The URLs stay relative to the page ('./…' in the build), so stored export settings keep
// working if the site moves; main.ts makes the STL URL absolute before handing it to the worker.

const asset = (file: string) => import.meta.env.BASE_URL + file;

export const ASSETS = {
  stl: asset('David_(Michelangelo).stl'),
  /** Merge tolerance in STL units (mm). */
  stlMergeTolerance: 1e-4,
  /** Output-intent profile (FOGRA39). The 260 % TAC variant works as well: K-only output is ≤ 100 %. */
  icc: asset('Coated_Fogra39L_VIGC_300.icc'),
  font: asset('Fira_Sans/FiraSans-Regular.ttf'),
  signature: asset('Michelangelo_Signature2.svg'),
};
