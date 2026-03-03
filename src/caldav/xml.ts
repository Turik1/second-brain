/** Check if a REPORT body is calendar-multiget (vs calendar-query) */
export function isMultigetReport(body: string): boolean {
  return body.includes('calendar-multiget');
}

/** Extract <D:href> values from a calendar-multiget XML body */
export function extractHrefsFromMultiget(body: string): string[] {
  const hrefs: string[] = [];
  const regex = /<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/gi;
  let match;
  while ((match = regex.exec(body)) !== null) {
    hrefs.push(match[1].trim());
  }
  return hrefs;
}

function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** PROPFIND response for /caldav/principal/ */
export function buildPrincipalPropfind(href: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal><D:href>/caldav/principal/</D:href></D:current-user-principal>
        <C:calendar-home-set><D:href>/caldav/calendars/</D:href></C:calendar-home-set>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:displayname>Second Brain</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
}

/** PROPFIND response for /caldav/calendars/ — lists the admin calendar */
export function buildCalendarHomePropfind(href: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:displayname>Calendars</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/caldav/calendars/admin/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Second Brain Admin</D:displayname>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
}

/** PROPFIND response for /caldav/calendars/admin/ — calendar properties with ctag */
export function buildCalendarPropfind(href: string, ctag: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Second Brain Admin</D:displayname>
        <CS:getctag>${xmlEscape(ctag)}</CS:getctag>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
}

export interface EventResponseEntry {
  href: string;
  etag: string;
  calendarData: string;
}

/** REPORT response with calendar data and etags (used for both multiget and query) */
export function buildMultigetResponse(events: EventResponseEntry[]): string {
  const responses = events
    .map(
      (e) => `  <D:response>
    <D:href>${xmlEscape(e.href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>${e.etag}</D:getetag>
        <C:calendar-data><![CDATA[${e.calendarData}]]></C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
${responses}
</D:multistatus>`;
}

/** PROPFIND response listing individual event resources (Depth: 1 on calendar) */
export function buildCalendarChildrenPropfind(
  calendarHref: string,
  ctag: string,
  events: Array<{ href: string; etag: string }>,
): string {
  const calendarResponse = `  <D:response>
    <D:href>${xmlEscape(calendarHref)}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Second Brain Admin</D:displayname>
        <CS:getctag>${xmlEscape(ctag)}</CS:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;

  const eventResponses = events
    .map(
      (e) => `  <D:response>
    <D:href>${xmlEscape(e.href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>${xmlEscape(e.etag)}</D:getetag>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
${calendarResponse}
${eventResponses}
</D:multistatus>`;
}
