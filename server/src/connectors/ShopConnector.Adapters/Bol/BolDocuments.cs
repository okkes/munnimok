using System.Text.RegularExpressions;

namespace ShopConnector.Adapters.Bol;

internal readonly record struct BolInvoiceLink(string InvoiceId);

// media type carried, not assumed from the URL: an expired session answers a PDF URL with an HTML page
internal readonly record struct BolDownload(int Status, string MediaType, byte[] Bytes);

// raw-body regex on purpose: bol renders ONE invoice anchor, the rest live only in a script payload that BolHtml strips
// (a real order had 3 invoices and 1 anchor); anchored on a PATH SEGMENT, not digits: help/product/order-item ids look alike
internal static class BolDocuments
{
    // deduped: the one rendered anchor also appears in the script payload, so it would be a second ~20 KB download
    public static IReadOnlyList<BolInvoiceLink> Parse(string body, BolOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (string.IsNullOrEmpty(body)) return [];

        var found = new List<BolInvoiceLink>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (Match match in Regex.Matches(
            body, options.InvoiceIdPattern, RegexOptions.IgnoreCase, TimeSpan.FromSeconds(5)))
        {
            var id = match.Groups["id"].Value;
            if (id.Length == 0 || !seen.Add(id)) continue;

            found.Add(new BolInvoiceLink(id));
        }

        return found;
    }
}
