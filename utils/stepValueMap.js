/**
 * Maps form labels → runtime context keys (per site).
 */

const INPUT_BY_LABEL = {
  'First Name': 'firstName',
  'Last Name': 'lastName',
  'National ID / IQAMA ID': 'nationalId',
  'Company Name': 'companyName',
  'First Name in Arabic': 'firstNameAr',
  'Last Name in Arabic': 'lastNameAr',
  'Full Name in English': 'fullNameEn',
  'Share Percentage': 'percentage',
  'Passport Number': 'passportNumber',
  'Passport number': 'passportNumber',
  'City': 'city',
  'Place of Birth': 'placeOfBirth',
  'Email': 'email',
  'Email Address': 'email',
  'Entity Name in English': 'entityNameEnglish',
  'Entity Name in Arabic': 'entityNameArabic',
  'Capital': 'capital',
};

const DROPDOWN_BY_LABEL = {
  'Title': 'title',
  'Sector': 'sector',
  'Country': 'country',
  'Identity Type': 'identityType',
  'Current Nationality': 'nationality',
  'Professional License': 'professionalLicense',
  'Legal Status': 'legalStatus',
};

const CALENDAR_BY_LABEL = {
  'Date of Birth': { day: 'dobDay', month: 'dobMonth', year: 'dobYear', calendarType: 'dobCalendar' },
  'Passport Issue Date': { day: 'issueDay', month: 'issueMonth', year: 'issueYear', calendarType: 'issueCalendar' },
  'ID Issue Date': { day: 'issueDay', month: 'issueMonth', year: 'issueYear', calendarType: 'issueCalendar' },
  'Passport Expiry Date': { day: 'expiryDay', month: 'expiryMonth', year: 'expiryYear', calendarType: 'expiryCalendar' },
  'ID Expiry Date': { day: 'expiryDay', month: 'expiryMonth', year: 'expiryYear', calendarType: 'expiryCalendar' },
};

const UPLOAD_BY_LABEL = {
  'Passport / License Copy': 'passportFile',
  'commercial_register': 'entityCRFile',
  'financial_statement': 'entityFSFile',
};

function pick(ctx, key) {
  if (!key || ctx[key] == null) return '';
  return String(ctx[key]);
}

export function resolveInputValue(step, ctx) {
  if (step.field === 'prefix') return pick(ctx, 'mobilePrefix');
  if (step.field === 'number') return pick(ctx, 'mobile');
  if (step.valueKey) return pick(ctx, step.valueKey);
  if (step.value != null && step.value !== '') return String(step.value);
  const key = INPUT_BY_LABEL[step.label];
  return key ? pick(ctx, key) : '';
}

export function resolveDropdownValue(step, ctx) {
  if (step.valueKey) return pick(ctx, step.valueKey);
  if (step.value != null && step.value !== '') return String(step.value);
  const key = DROPDOWN_BY_LABEL[step.label];
  if (key) return pick(ctx, key);
  if (step.label === 'Mobile Number' && step.field === 'prefix') return pick(ctx, 'mobilePrefix');
  return '';
}

export function resolveCalendarParts(step, ctx) {
  const map = CALENDAR_BY_LABEL[step.label];
  if (map) {
    return {
      day: pick(ctx, map.day) || '1',
      month: pick(ctx, map.month) || 'January',
      year: pick(ctx, map.year) || '1990',
      calendarType: pick(ctx, map.calendarType) || step.calendarType || 'Gregorian',
    };
  }
  return {
    day: step.day || '1',
    month: step.month || 'January',
    year: step.year || '1990',
    calendarType: step.calendarType || 'Gregorian',
  };
}

export function resolveUploadPath(step, ctx) {
  if (step.valueKey) return pick(ctx, step.valueKey);
  const key = UPLOAD_BY_LABEL[step.label];
  return key ? pick(ctx, key) : (step.value || '');
}

/** Flatten contact-person runtime vars for calendar/mobile label maps */
export function buildContactContext(state) {
  return {
    ...state,
    title: state.contactTitle,
    firstNameAr: state.contactFirstNameAr,
    lastNameAr: state.contactLastNameAr,
    fullNameEn: state.contactFullNameEn,
    nationality: state.contactNationality,
    passportNumber: state.contactPassportNumber,
    country: state.contactCountry,
    city: state.contactCity,
    email: state.contactEmail,
    mobilePrefix: state.contactMobilePrefix,
    mobile: state.contactMobile,
    identityType: 'Passport',
    dobDay: state.contactDobDay,
    dobMonth: state.contactDobMonth,
    dobYear: state.contactDobYear,
    issueDay: state.contactIssueDay,
    issueMonth: state.contactIssueMonth,
    issueYear: state.contactIssueYear,
    expiryDay: state.contactExpiryDay,
    expiryMonth: state.contactExpiryMonth,
    expiryYear: state.contactExpiryYear,
  };
}

/** Registration page + credentials (Step 1–2) */
export function buildEntityContext(state) {
  return {
    entityNameEnglish: state.entityNameEnglish,
    entityNameArabic: state.entityNameArabic,
    legalStatus: state.legalStatus,
    capital: state.capital,
    entityEmail: state.entityEmail,
    entityMobilePrefix: state.entityMobilePrefix,
    entityMobile: state.entityMobile,
    region: state.region,
    city: state.city,
    investmentSpending: state.investmentSpending,
    entityCRFile: state.entityCRFile,
    entityFSFile: state.entityFSFile,
  };
}

export function buildRegistrationContext(state) {
  return {
    regTitle: state.regTitle,
    firstName: state.firstName,
    lastName: state.lastName,
    nationalId: state.nationalId || '',
    companyName: state.companyName,
    sector: state.sector,
    targetEmail: state.targetEmail,
    country: state.country,
    regMobile: state.regMobile,
    credsUsername: state.credsUsername,
    credsPassword: state.credsPassword,
  };
}

export function buildShareholderPersonContext(sh, state = {}) {
  return {
    ...state,
    ...sh,
    identityType: 'Passport',
    title: sh.title || 'Mr.',
    firstNameAr: sh.firstNameAr || '',
    lastNameAr: sh.lastNameAr || '',
    fullNameEn: sh.fullNameEn || sh.nameEng || '',
    percentage: sh.percentage || '',
    passportNumber: sh.passportNumber || '',
    nationality: sh.nationality || sh.country || '',
    country: sh.country || '',
    city: sh.city || '',
    professionalLicense: sh.professionalLicense || 'No',
    placeOfBirth: sh.placeOfBirth || '',
    email: sh.email || '',
    mobilePrefix: sh.mobilePrefix || '+213',
    mobile: sh.mobile || '',
    dobDay: sh.dobDay,
    dobMonth: sh.dobMonth,
    dobYear: sh.dobYear,
    dobCalendar: sh.dobCalendar || 'Gregorian',
    issueDay: sh.issueDay,
    issueMonth: sh.issueMonth,
    issueYear: sh.issueYear,
    issueCalendar: sh.issueCalendar || 'Gregorian',
    expiryDay: sh.expiryDay,
    expiryMonth: sh.expiryMonth,
    expiryYear: sh.expiryYear,
    expiryCalendar: sh.expiryCalendar || 'Gregorian',
    passportFile: sh.passportFile || '',
  };
}
