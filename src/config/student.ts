// The student's details, entered in the app panel. They name the exported PDF
// (Surname_StudentNumber_01_MB.pdf) and go into its metadata (Author, Subject).

export interface Student {
  forename: string;
  surname: string;
  studentNumber: string;
}

export const EMPTY_STUDENT: Student = { forename: '', surname: '', studentNumber: '' };

/** Project suffix of the file name, from the school brief: project 01, Michelangelo Buonarroti. */
export const PROJECT_SUFFIX = '01_MB';

const clean = (s: string) => s.trim().replace(/\s+/g, ' ');

/** Surname and student number are needed for the file name; the forename only for the metadata. */
export function missingFields(s: Student): Array<keyof Student> {
  const missing: Array<keyof Student> = [];
  if (!clean(s.forename)) missing.push('forename');
  if (!clean(s.surname)) missing.push('surname');
  if (!clean(s.studentNumber)) missing.push('studentNumber');
  return missing;
}

/**
 * "Muster_12345678_01_MB.pdf". Spaces inside a name become hyphens; characters that are not
 * allowed in file names (\ / : * ? " < > |) are dropped. Umlauts and accents are kept.
 */
export function pdfFilename(s: Student): string {
  const part = (v: string) => clean(v).replace(/[\\/:*?"<>|]+/g, '').replace(/ /g, '-');
  return `${part(s.surname)}_${part(s.studentNumber)}_${PROJECT_SUFFIX}.pdf`;
}

/** PDF metadata: Author = full name, Subject = student number. */
export function pdfMeta(s: Student): { author: string; subject: string } {
  return {
    author: clean(`${s.forename} ${s.surname}`),
    subject: `Student number ${clean(s.studentNumber)}`,
  };
}
