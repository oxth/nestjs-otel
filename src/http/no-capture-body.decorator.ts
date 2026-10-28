import { SetMetadata } from '@nestjs/common';

export const NO_CAPTURE_BODY_META = '@oxth/nestjs-otel:no-capture-body';

/** Never put this handler's (or controller's) request body on the span, even on failure. */
export function NoCaptureBody(): ClassDecorator & MethodDecorator {
  return SetMetadata(NO_CAPTURE_BODY_META, true);
}
