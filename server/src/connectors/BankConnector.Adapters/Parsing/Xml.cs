using System.Xml.Linq;

namespace BankConnector.Adapters.Parsing;

// local names only: the namespace encodes the message version (camt.053.001.02 vs .08) and Dutch banks ship several,
// while the element names did not change
internal static class Xml
{
    public static XElement? Child(this XElement? parent, string localName) =>
        parent.Children(localName).FirstOrDefault();

    public static IEnumerable<XElement> Children(this XElement? parent, string localName) =>
        parent is null
            ? []
            : parent.Elements().Where(e => string.Equals(e.Name.LocalName, localName, StringComparison.Ordinal));

    public static XElement? Path(this XElement? parent, params string[] localNames)
    {
        var current = parent;
        foreach (var name in localNames)
        {
            current = current.Child(name);
            if (current is null) return null;
        }

        return current;
    }

    // present but empty reads as absent: a bank emitting <Nm/> is saying it has no name
    public static string? Text(this XElement? element)
    {
        var value = element?.Value.Trim();
        return string.IsNullOrEmpty(value) ? null : value;
    }

    // named Attr, not Attribute: an extension method never wins against XElement.Attribute(XName)
    public static string? Attr(this XElement? element, string localName)
    {
        var attribute = element?.Attributes()
            .FirstOrDefault(a => string.Equals(a.Name.LocalName, localName, StringComparison.Ordinal));

        var value = attribute?.Value.Trim();
        return string.IsNullOrEmpty(value) ? null : value;
    }
}
