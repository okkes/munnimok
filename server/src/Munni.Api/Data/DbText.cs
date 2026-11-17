using System.Text;

namespace Munni.Api.Data;

/// <summary>What the database can say about a text without reading it.</summary>
public static class DbText
{
    /// the bytes a text takes: PostgreSQL's octet_length answers from the value's header, where length() would
    /// read a stored invoice whole to count its characters
    public static int OctetLength(string value) => Encoding.UTF8.GetByteCount(value);
}
