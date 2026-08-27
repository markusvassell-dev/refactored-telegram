import type { ReactNode } from 'react';

/**
 * The client details a person may type, as one set of inputs used by both the
 * add and the edit screen.
 *
 * One component rather than two forms that happen to match, because the set of
 * writable fields is a rule rather than a layout: a column that appears on one
 * screen and not the other is a column somebody can change in one place and not
 * the other, and the difference would be invisible until it mattered.
 *
 * Every field here is one the firm owns. Karbon's mirror columns —
 * `karbonEntityKey`, `karbonFullName`, `karbonContactType` and the rest — are
 * deliberately absent and shown read-only by the caller: they record what the
 * vendor said, and a field that records a vendor and can also be typed over
 * stops being evidence of anything. `karbonFullName` in particular is the only
 * record of the right name when the stored one is wrong.
 */

export interface ClientDetailsValues {
  legalName?: string | null;
  displayName?: string | null;
  businessNumber?: string | null;
  trustAccountNumber?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
  clientGroup?: string | null;
}

function Field({
  name,
  label,
  value,
  note,
  required,
  placeholder,
}: {
  name: string;
  label: string;
  value?: string | null;
  note?: ReactNode;
  required?: boolean;
  placeholder?: string;
}): ReactNode {
  const id = `client-${name}`;
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
        {required ? null : <span className="ml-1 font-normal text-slate-500">(optional)</span>}
      </label>
      <input
        id={id}
        name={name}
        className="input"
        defaultValue={value ?? ''}
        required={required}
        placeholder={placeholder}
      />
      {note ? <p className="field-note">{note}</p> : null}
    </div>
  );
}

export function ClientDetailsFields({ values }: { values?: ClientDetailsValues }): ReactNode {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field
          name="legalName"
          label="Legal name"
          value={values?.legalName}
          required
          placeholder="2409116 Alberta Ltd."
          note="The entity that signs the engagement letter. This is the string that prints on it."
        />
      </div>

      <Field
        name="displayName"
        label="Trade name"
        value={values?.displayName}
        placeholder="Lava Grill Seton"
        note="What people here call the client. Never printed on a letter — it is for finding the client on a screen."
      />

      <Field
        name="clientGroup"
        label="Client group"
        value={values?.clientGroup}
        note="For related entities that are worked on together."
      />

      <Field
        name="businessNumber"
        label="Business number"
        value={values?.businessNumber}
        placeholder="123456789 RC0001"
        note="Nine digits, optionally with a programme identifier. Prints on a T2 letter. The firm’s own client code is not a business number and is refused."
      />

      <Field
        name="trustAccountNumber"
        label="Trust account number"
        value={values?.trustAccountNumber}
        placeholder="T12345678"
        note="The letter T and eight digits. Prints on a T3 letter, and this is the only place it can be set — Karbon holds no such field."
      />

      <div className="sm:col-span-2">
        <Field name="addressLine1" label="Address line 1" value={values?.addressLine1} />
      </div>
      <div className="sm:col-span-2">
        <Field name="addressLine2" label="Address line 2" value={values?.addressLine2} />
      </div>

      <Field name="city" label="City" value={values?.city} />
      <Field name="province" label="Province or state" value={values?.province} />

      <Field
        name="postalCode"
        label="Postal code"
        value={values?.postalCode}
        placeholder="T2X 1A1"
        note="Checked and tidied to A1A 1A1 for Canadian addresses. Set the country first if this client is elsewhere."
      />

      <Field
        name="country"
        label="Country"
        value={values?.country}
        placeholder="Canada"
        note="Left blank means Canada."
      />
    </div>
  );
}
