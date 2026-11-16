using System.Globalization;
using Connector.Kit.Errors;
using Connector.Kit.Jobs;
using Connector.Kit.Manifests;

namespace Connector.Kit.Hosting.Endpoints;

/// The only door to an adapter: the manifest declares every legal parameter. An unknown key is rejected, because a
/// misspelled <c>since</c> would silently return a full history.
public static class ParamBinder
{
    public const string Since = "since";
    public const string Until = "until";

    public static ResourceRequest Bind(
        ProviderManifest manifest,
        ResourceSpec resource,
        IReadOnlyDictionary<string, IReadOnlyList<string>> query,
        DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ArgumentNullException.ThrowIfNull(resource);
        ArgumentNullException.ThrowIfNull(query);

        foreach (var key in query.Keys)
        {
            var spec = resource.Param(key)
                       ?? throw ConnectorException.InvalidRequest($"unknown parameter '{key}' for resource '{resource.Id}'");

            // internal params are for operators: a caller that could set one would reach past the manifest
            if (spec.Internal)
            {
                throw ConnectorException.InvalidRequest($"parameter '{key}' is not settable by a caller");
            }
        }

        var missing = resource.Params
            .Where(p => p is { Required: true, Internal: false })
            .Select(spec => spec.Key)
            .FirstOrDefault(key => !query.ContainsKey(key) || query[key].Count == 0);

        if (missing is not null)
        {
            throw ConnectorException.InvalidRequest($"parameter '{missing}' is required");
        }

        DateOnly? since = null;
        DateOnly? until = null;
        var selections = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);

        foreach (var (key, rawValues) in query)
        {
            var spec = resource.Param(key)!;
            var values = Expand(spec, rawValues);

            switch (key)
            {
                case Since:
                    since = ParseDate(key, values[0]);
                    break;
                case Until:
                    until = ParseDate(key, values[0]);
                    break;
                default:
                    foreach (var value in values) Validate(spec, value);
                    selections[key] = values;
                    break;
            }
        }

        if (since is { } from && until is { } to && to < from)
        {
            throw ConnectorException.InvalidRequest("until is before since");
        }

        var limits = manifest.Limits;
        since = Widen(since, limits, resource, now);

        return new ResourceRequest
        {
            ResourceId = resource.Id,
            Since = since,
            Until = until,
            Selections = selections,
        };
    }

    /// Widens the window back by the settlement lag, then clamps to the provider's history: rows that settle late are
    /// otherwise lost for good. Overlap is free: (session, external_id) uniqueness and the content hash stop duplicates.
    private static DateOnly? Widen(DateOnly? since, ProviderLimits limits, ResourceSpec resource, DateTimeOffset now)
    {
        var maxHistoryDays = resource.MaxHistoryDays ?? limits.MaxHistoryDays;
        var earliest = DateOnly.FromDateTime(now.UtcDateTime).AddDays(-maxHistoryDays);

        if (since is null) return null;

        var widened = since.Value.AddDays(-limits.SettlementLagDays);
        return widened < earliest ? earliest : widened;
    }

    /// Repeated keys and one comma-separated value mean the same (<c>accounts=savings,credit_card</c>).
    private static List<string> Expand(ParamSpec spec, IReadOnlyList<string> raw)
    {
        var values = new List<string>();
        foreach (var value in raw)
        {
            if (spec.Multi)
            {
                values.AddRange(value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            }
            else
            {
                values.Add(value.Trim());
            }
        }

        if (values.Count == 0)
        {
            throw ConnectorException.InvalidRequest($"parameter '{spec.Key}' has no value");
        }

        if (!spec.Multi && values.Count > 1)
        {
            throw ConnectorException.InvalidRequest($"parameter '{spec.Key}' accepts one value");
        }

        return values;
    }

    private static void Validate(ParamSpec spec, string value)
    {
        switch (spec.Type)
        {
            case ParamType.Enum:
                if (spec.Values is null || !spec.Values.Contains(value, StringComparer.Ordinal))
                {
                    throw ConnectorException.InvalidRequest($"parameter '{spec.Key}' does not accept '{value}'");
                }

                break;

            case ParamType.Number:
                if (!long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out _))
                {
                    throw ConnectorException.InvalidRequest($"parameter '{spec.Key}' must be a number");
                }

                break;

            case ParamType.Bool:
                if (!bool.TryParse(value, out _))
                {
                    throw ConnectorException.InvalidRequest($"parameter '{spec.Key}' must be true or false");
                }

                break;

            case ParamType.Date:
                _ = ParseDate(spec.Key, value);
                break;

            case ParamType.Text:
                if (value.Length > 256)
                {
                    throw ConnectorException.InvalidRequest($"parameter '{spec.Key}' is too long");
                }

                break;

            default:
                throw ConnectorException.InvalidRequest($"parameter '{spec.Key}' has an unsupported type");
        }
    }

    private static DateOnly ParseDate(string key, string value) =>
        DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed)
            ? parsed
            : throw ConnectorException.InvalidRequest($"parameter '{key}' must be a date as YYYY-MM-DD");
}
