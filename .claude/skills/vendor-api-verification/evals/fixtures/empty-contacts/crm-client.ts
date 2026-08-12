/**
 * Acme CRM client.
 *
 * The vendor publishes an OpenAPI specification; a copy is in `openapi.json`
 * next to this file.
 */

export interface CrmPerson {
  personKey: string;
  fullName: string;
  firstName: string | null;
  email: string | null;
  telephone: string | null;
}

export interface CrmCompany {
  companyKey: string;
  legalName: string;
  addressLine1: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  people: CrmPerson[];
}

export class CrmClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private async request<T>(path: string): Promise<T | null> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    // A read that found nothing is an answer, not an error.
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Acme CRM: HTTP ${response.status} for ${path}`);

    return (await response.json()) as T;
  }

  async getCompany(companyKey: string): Promise<CrmCompany | null> {
    const raw = await this.request<Record<string, any>>(`/v3/Companies/${encodeURIComponent(companyKey)}`);
    if (!raw) return null;

    const address = (raw.AddressLines ?? raw.Address ?? {}) as Record<string, any>;
    const people = Array.isArray(raw.People) ? raw.People : [];

    return {
      companyKey: String(raw.CompanyKey ?? ''),
      legalName: String(raw.LegalName ?? ''),
      addressLine1: address.AddressLine1 ?? null,
      city: address.City ?? null,
      province: address.StateProvince ?? null,
      postalCode: address.PostCode ?? null,
      people: people.map((person: Record<string, any>) => ({
        personKey: String(person.PersonKey ?? ''),
        fullName: String(person.FullName ?? ''),
        firstName: person.FirstName ?? null,
        email: person.EmailAddress ?? null,
        telephone: person.PhoneNumber ?? null,
      })),
    };
  }
}
