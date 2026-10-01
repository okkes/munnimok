using System.Text.RegularExpressions;

namespace ShopConnector.Adapters.Bol;

/// <summary>One invoice bol holds for an order.</summary>
internal readonly record struct BolInvoiceLink(string InvoiceId);

/// <summary>
/// A document as it came back: the status, what bol SAID it is, and the bytes.
///
/// The media type is carried rather than assumed from the URL, because a
/// session that expires between the order list and the download answers a URL
/// promising a PDF with an HTML page - and a connector that trusted the path
/// would hand somebody a download that opens to nothing.
/// </summary>
internal readonly record struct BolDownload(int Status, string MediaType, byte[] Bytes);

/// <summary>
/// Finding the invoices on an order-details page.
///
/// This reads the RAW BODY with a pattern, which every other reader on this
/// adapter deliberately does not do - <see cref="BolHtml"/> exists so that
/// nothing here has to. The page forces it, and the reason is worth stating
/// because "use the DOM" is the correct instinct and would silently lose data
/// here:
///
/// bol renders exactly ONE invoice anchor into the markup - the one belonging
/// to the item named in the URL's <c>order_item_id</c> - while the order's
/// other invoices exist only inside a React Router payload in a
/// <c>&lt;script&gt;</c> block. A real order carried THREE invoices and showed
/// one anchor. <see cref="BolHtml"/> strips script blocks before it reads
/// anything, by design and correctly, so a DOM-shaped reader on this adapter
/// could never see the other two however good its selectors were.
///
/// What makes a text scan safe here is the anchor being a PATH SEGMENT rather
/// than a shape of number. The same page carries sixteen-digit help-article
/// ids, sixteen-digit product ids and fourteen-digit order-item ids; an
/// invoice id is thirteen. Matching digits would attach a help article to
/// somebody's receipt.
/// </summary>
internal static class BolDocuments
{
    /// <summary>
    /// Every invoice on this page, in the order it first appears, without
    /// duplicates.
    ///
    /// The dedupe is not tidiness. The one invoice bol renders as an anchor
    /// also appears in the script payload, so the same document arrives twice
    /// on every order - and each one is a separate download and a separate
    /// attachment of roughly twenty kilobytes.
    /// </summary>
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
