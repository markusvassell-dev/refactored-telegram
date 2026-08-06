import { NextResponse } from 'next/server';
import { AppError } from '@element/shared';
import { container } from '@/lib/container';
import { requireUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * The approved master template, to read.
 *
 * `?format=pdf` (the default) converts it for reading in the browser;
 * `?format=docx` returns the normalised source, which is what someone revising
 * the wording needs to open in Word.
 *
 * No signed link. A template is the firm's own approved wording rather than a
 * client's document — the Templates screen is already open to any signed-in
 * user, and the same rule applies here. Nothing on this route can modify a
 * template.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ versionId: string }> },
): Promise<Response> {
  try {
    await requireUser();
  } catch {
    return NextResponse.json({ error: 'Sign in to read templates.' }, { status: 401 });
  }

  const { versionId } = await context.params;
  const format = new URL(request.url).searchParams.get('format') === 'docx' ? 'docx' : 'pdf';

  try {
    const preview =
      format === 'docx'
        ? await container.templatePreviews.docx(versionId)
        : await container.templatePreviews.pdf(versionId);

    return new NextResponse(new Uint8Array(preview.content), {
      headers: {
        'content-type':
          format === 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        // A PDF is read in place; a .docx is being taken away to be edited.
        'content-disposition': `${format === 'pdf' ? 'inline' : 'attachment'}; filename="${preview.fileName}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    const status = error instanceof AppError && error.category === 'NOT_FOUND' ? 404 : 500;
    const message =
      error instanceof AppError
        ? error.userMessage
        : 'The template could not be prepared for reading. An administrator can find the detail in the system logs.';

    container.logger.error('Template preview failed', {
      templateVersionId: versionId,
      format,
      reason: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: message }, { status });
  }
}
