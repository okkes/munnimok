using System.Text.Json;
using Connector.Api.Tests.Infrastructure;

namespace Connector.Api.Tests;

/// responses were once all bodyless 200s: minimal APIs read the handler's declared return type,
/// and every helper returned IResult; assertions are exact $ref strings because
/// substring checks passed while every response was empty
[Collection(ShopApiCollection.Name)]
public sealed class ApiDocumentTests(ShopApiFactory factory)
{
    /// routes whose success carries no body; any other empty success is a route nobody annotated
    private static readonly HashSet<string> BodylessOnPurpose = new(StringComparer.Ordinal)
    {
        // 200 either way, deliberately empty: a stale frame is the network's fault, and an error would make an agent retry it
        "post /agent/v1/jobs/{jobId}/live/frame 200",
    };

    private async Task<JsonElement> DocumentAsync()
    {
        using var http = factory.CreateClient();
        using var stream = await http.GetStreamAsync("/openapi/v1.json");
        using var parsed = await JsonDocument.ParseAsync(stream);
        return parsed.RootElement.Clone();
    }

    private static JsonElement Response(JsonElement document, string path, string method, string status) =>
        document.GetProperty("paths").GetProperty(path).GetProperty(method).GetProperty("responses")
            .GetProperty(status);

    [Theory]
    [InlineData("/v1/health", "get", "200", "HealthResponse")]
    [InlineData("/v1/providers", "get", "200", "CatalogResponse")]
    [InlineData("/v1/status", "get", "200", "StatusResponse")]
    [InlineData("/v1/admin/providers/{id}/status", "post", "200", "ProviderStatus")]
    // the 202 is the same body under a different promise: poll or subscribe
    [InlineData("/v1/{provider}/login", "post", "200", "SessionResponse")]
    [InlineData("/v1/{provider}/login", "post", "202", "SessionResponse")]
    [InlineData("/v1/{provider}/login/{sessionId}", "get", "200", "SessionResponse")]
    [InlineData("/v1/{provider}/login/{sessionId}/answer", "post", "200", "SessionResponse")]
    [InlineData("/v1/{provider}/login/{sessionId}/cancel", "post", "200", "SessionResponse")]
    [InlineData("/v1/{provider}/sessions/resume", "post", "200", "ResumeResponse")]
    [InlineData("/v1/{provider}/{resource}", "get", "200", "DataResponse")]
    [InlineData("/v1/{provider}/{resource}", "get", "202", "JobAcceptedResponse")]
    [InlineData("/v1/{provider}/{resource}:fetch", "post", "200", "DataResponse")]
    [InlineData("/v1/{provider}/{resource}:fetch", "post", "202", "JobAcceptedResponse")]
    [InlineData("/v1/{provider}/{resource}/ack", "post", "200", "AckResponse")]
    [InlineData("/v1/{provider}/jobs/{jobId}", "get", "200", "JobResponse")]
    [InlineData("/v1/{provider}/jobs/{jobId}/answer", "post", "200", "JobResponse")]
    [InlineData("/v1/{provider}/jobs/{jobId}/artifacts/share", "post", "200", "ArtifactShareResponse")]
    [InlineData("/v1/admin/jobs", "get", "200", "JobListResponse")]
    [InlineData("/v1/admin/jobs/{jobId}", "get", "200", "OperatorJobView")]
    [InlineData("/v1/admin/health", "get", "200", "HealthReportResponse")]
    [InlineData("/v1/admin/canaries/{id}/run", "post", "200", "CanaryView")]
    [InlineData("/v1/agents", "get", "200", "AgentListResponse")]
    [InlineData("/v1/agents/enrollment", "post", "200", "AgentEnrollmentResponse")]
    [InlineData("/agent/v1/enroll", "post", "200", "EnrollResponse")]
    [InlineData("/agent/v1/heartbeat", "post", "200", "HeartbeatResponse")]
    [InlineData("/agent/v1/jobs/lease", "post", "200", "LeasedJob")]
    [InlineData("/agent/v1/jobs/{jobId}/renew", "post", "200", "RenewResponse")]
    [InlineData("/agent/v1/jobs/{jobId}/challenge", "post", "200", "RaiseChallengeResponse")]
    [InlineData("/agent/v1/jobs/{jobId}/answer", "get", "200", "ChallengeAnswer")]
    [InlineData("/agent/v1/jobs/{jobId}/result", "post", "200", "AgentAckResponse")]
    [InlineData("/agent/v1/jobs/{jobId}/fail", "post", "200", "AgentFailResponse")]
    [InlineData("/agent/v1/jobs/{jobId}/live/input", "get", "200", "LiveInputBatch")]
    public async Task A_json_route_names_the_schema_it_returns(
        string path, string method, string status, string schema)
    {
        var document = await DocumentAsync();

        var body = Response(document, path, method, status)
            .GetProperty("content").GetProperty("application/json").GetProperty("schema");

        Assert.Equal($"#/components/schemas/{schema}", body.GetProperty("$ref").GetString());
    }

    [Theory]
    // a stream of the view the poll returns, one per event; without the frame type a consumer is told it returns nothing
    [InlineData("/v1/{provider}/login/{sessionId}/events", "get", "text/event-stream", "SessionResponse")]
    [InlineData("/v1/{provider}/jobs/{jobId}/events", "get", "text/event-stream", "JobResponse")]
    [InlineData("/v1/{provider}/login/{sessionId}/challenges/{challengeId}/live/stream", "get", "text/event-stream", "LiveStreamFrame")]
    public async Task A_stream_names_its_media_type_and_the_view_it_carries(
        string path, string method, string mediaType, string schema)
    {
        var document = await DocumentAsync();

        var content = Response(document, path, method, "200").GetProperty("content");

        // the media type is the assertion: an event stream documented as application/json would be read wrongly
        Assert.Equal(mediaType, Assert.Single(content.EnumerateObject()).Name);
        Assert.Equal(
            $"#/components/schemas/{schema}",
            content.GetProperty(mediaType).GetProperty("schema").GetProperty("$ref").GetString());
    }

    [Theory]
    [InlineData("/v1/{provider}/login/{sessionId}/challenges/{challengeId}/image", "image/png")]
    [InlineData("/v1/{provider}/login/{sessionId}/challenges/{challengeId}/live/frame", "image/jpeg")]
    public async Task A_picture_is_documented_as_binary_under_its_own_media_type(string path, string mediaType)
    {
        var document = await DocumentAsync();

        var content = Response(document, path, "get", "200").GetProperty("content");

        Assert.Equal(mediaType, Assert.Single(content.EnumerateObject()).Name);

        var schema = content.GetProperty(mediaType).GetProperty("schema");
        Assert.Equal("string", schema.GetProperty("type").GetString());
        Assert.Equal("byte", schema.GetProperty("format").GetString());
    }

    /// the manifest is serialised through a node, so there is no C# type to point at;
    /// the list endpoint declares providers the same way
    [Fact]
    public async Task A_manifest_is_documented_as_the_free_form_object_it_is()
    {
        var document = await DocumentAsync();

        var schema = Response(document, "/v1/providers/{id}", "get", "200")
            .GetProperty("content").GetProperty("application/json").GetProperty("schema");

        Assert.Equal("#/components/schemas/JsonObject", schema.GetProperty("$ref").GetString());

        var jsonObject = document.GetProperty("components").GetProperty("schemas").GetProperty("JsonObject");
        Assert.Equal("object", jsonObject.GetProperty("type").GetString());
        Assert.False(jsonObject.TryGetProperty("properties", out _));
    }

    [Fact]
    public async Task A_list_of_profiles_is_documented_as_an_array_of_them()
    {
        var document = await DocumentAsync();

        var schema = Response(document, "/v1/agents/{agentId}/profiles", "get", "200")
            .GetProperty("content").GetProperty("application/json").GetProperty("schema");

        Assert.Equal("array", schema.GetProperty("type").GetString());
        Assert.Equal(
            "#/components/schemas/ProfileView",
            schema.GetProperty("items").GetProperty("$ref").GetString());
    }

    /// handlers return a JsonArray, so `data` resolved to an array of anything;
    /// it now resolves to the manifest's `returns` model
    [Theory]
    [InlineData("/v1/{provider}/{resource}", "get", "200", "DataResponse")]
    [InlineData("/v1/{provider}/{resource}:fetch", "post", "200", "DataResponse")]
    [InlineData("/v1/{provider}/jobs/{jobId}", "get", "200", "JobResponse")]
    public async Task A_fetch_names_the_record_it_hands_back(
        string path, string method, string status, string envelope)
    {
        var document = await DocumentAsync();

        // through the route, not the component: a reader of THIS operation must arrive at the model
        var body = Response(document, path, method, status)
            .GetProperty("content").GetProperty("application/json").GetProperty("schema");

        Assert.Equal($"#/components/schemas/{envelope}", body.GetProperty("$ref").GetString());

        var rows = document.GetProperty("components").GetProperty("schemas")
            .GetProperty(envelope).GetProperty("properties").GetProperty("data");

        // one control plane hosts every pack, so the rows are one of its providers' records
        var options = rows.GetProperty("items").GetProperty("oneOf").EnumerateArray()
            .Select(option => option.GetProperty("$ref").GetString())
            .ToList();
        Assert.Contains("#/components/schemas/Receipt", options);

        // the description carries the manifest's own `returns` word, so catalogue and reference can be joined
        Assert.Contains("`receipt`", rows.GetProperty("description").GetString()!, StringComparison.Ordinal);
    }

    /// exactly the shapes the registered manifests return, taken off the catalogue
    /// so a new provider record is held to it on arrival
    [Fact]
    public async Task A_service_offers_exactly_the_shapes_its_own_providers_return()
    {
        var document = await DocumentAsync();

        using var http = factory.CreateAuthorizedClient();
        using var response = await http.GetAsync("/v1/providers");
        var providers = (await response.JsonAsync()).GetProperty("providers");
        var returned = providers.EnumerateArray()
            .SelectMany(provider => provider.GetProperty("resources").EnumerateArray())
            .Select(resource => resource.GetProperty("returns").GetString()!)
            .Distinct()
            .OrderBy(word => word, StringComparer.Ordinal)
            .ToList();
        Assert.True(returned.Count > 1, "the unified control plane serves more than one record shape");

        var data = document.GetProperty("components").GetProperty("schemas")
            .GetProperty("DataResponse").GetProperty("properties").GetProperty("data");
        var offered = data.GetProperty("items").GetProperty("oneOf").EnumerateArray()
            .Select(option => option.GetProperty("$ref").GetString()!.Split('/').Last())
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();

        // the wire word (snake_case) and the schema name (PascalCase) are the same shape
        static string Pascal(string word) => string.Concat(word.Split('_').Select(part => char.ToUpperInvariant(part[0]) + part[1..]));
        Assert.Equal(returned.Select(Pascal).OrderBy(name => name, StringComparer.Ordinal).ToList(), offered);

        var description = data.GetProperty("description").GetString()!;
        foreach (var word in returned) Assert.Contains($"`{word}`", description, StringComparison.Ordinal);
    }

    /// a job not finished has no rows: describing the array's contents must not change whether there is one
    [Fact]
    public async Task A_jobs_rows_may_still_be_absent()
    {
        var document = await DocumentAsync();

        var types = document.GetProperty("components").GetProperty("schemas")
            .GetProperty("JobResponse").GetProperty("properties").GetProperty("data")
            .GetProperty("type").EnumerateArray().Select(t => t.GetString()).ToList();

        Assert.Contains("array", types);
        Assert.Contains("null", types);

        var required = document.GetProperty("components").GetProperty("schemas")
            .GetProperty("DataResponse").GetProperty("required")
            .EnumerateArray().Select(r => r.GetString()).ToList();

        Assert.Contains("data", required);
    }

    [Fact]
    public async Task The_published_record_is_described_as_it_is_serialised()
    {
        var document = await DocumentAsync();

        var receipt = document.GetProperty("components").GetProperty("schemas").GetProperty("Receipt");
        var properties = receipt.GetProperty("properties").EnumerateObject().Select(p => p.Name).ToList();

        Assert.Contains("external_id", properties);
        Assert.Contains("purchased_at", properties);
        Assert.Contains("content_hash", properties);
        Assert.Contains("total_is_derived", properties);
        Assert.Contains("reconciled", properties);

        // the camelCase a default generator would produce is never sent
        Assert.DoesNotContain("externalId", properties);
        Assert.DoesNotContain("totalIsDerived", properties);

        Assert.Equal(
            "#/components/schemas/ReceiptItem",
            receipt.GetProperty("properties").GetProperty("items")
                .GetProperty("items").GetProperty("$ref").GetString());
    }

    /// the generator walks handler signatures while records are added by a transformer, so a route can point at a schema never
    /// emitted; a dangling pointer is worse than a gap, which is visible
    [Fact]
    public async Task Every_reference_in_the_document_resolves()
    {
        var document = await DocumentAsync();
        var schemas = document.GetProperty("components").GetProperty("schemas");

        var dangling = new SortedSet<string>(StringComparer.Ordinal);
        var seen = 0;

        void Walk(JsonElement node)
        {
            switch (node.ValueKind)
            {
                case JsonValueKind.Object:
                    foreach (var property in node.EnumerateObject())
                    {
                        if (property.NameEquals("$ref") && property.Value.GetString() is { } reference)
                        {
                            seen++;
                            var name = reference[(reference.LastIndexOf('/') + 1)..];
                            if (!schemas.TryGetProperty(name, out _)) dangling.Add(reference);
                        }

                        Walk(property.Value);
                    }

                    break;

                case JsonValueKind.Array:
                    foreach (var item in node.EnumerateArray()) Walk(item);
                    break;

                default:
                    break;
            }
        }

        Walk(document);

        Assert.Empty(dangling);

        // A walk that found nothing would pass for the wrong reason.
        Assert.True(seen > 50, $"only {seen} references in the whole document?");
    }

    [Theory]
    // 204 only: default inference claims a 200 for handlers it cannot read. The disconnect left this list: it answers 200
    // with `logged_out`, since a 204 left consumers nothing to report but the manifest's claim
    [InlineData("/v1/agents/{agentId}", "delete")]
    [InlineData("/agent/v1/jobs/{jobId}/progress", "post")]
    public async Task A_route_that_only_ever_returns_204_does_not_advertise_a_200(string path, string method)
    {
        var document = await DocumentAsync();

        var responses = Response(document, path, method, "204");
        Assert.False(responses.TryGetProperty("content", out _));

        var codes = document.GetProperty("paths").GetProperty(path).GetProperty(method)
            .GetProperty("responses").EnumerateObject().Select(p => p.Name);

        Assert.DoesNotContain("200", codes);
    }

    /// guard against route thirty-seven: a new endpoint that never says what it returns lands here, not documented as empty
    [Fact]
    public async Task No_route_documents_a_success_with_no_body_unless_it_has_none()
    {
        var document = await DocumentAsync();

        var empty = new List<string>();
        var operations = 0;

        foreach (var path in document.GetProperty("paths").EnumerateObject())
        {
            foreach (var operation in path.Value.EnumerateObject())
            {
                operations++;

                foreach (var response in operation.Value.GetProperty("responses").EnumerateObject())
                {
                    // 204 and 202 say "no body" by their own meaning; every
                    // other success is a promise of one.
                    if (!response.Name.StartsWith('2') || response.Name.Length != 3) continue;
                    if (response.Name is "204" or "202") continue;
                    if (response.Value.TryGetProperty("content", out _)) continue;

                    empty.Add($"{operation.Name} {path.Name} {response.Name}");
                }
            }
        }

        Assert.Equal(BodylessOnPurpose, empty.ToHashSet(StringComparer.Ordinal));

        // the count makes a vanished route as loud as an undocumented one
        Assert.Equal(65, operations);
    }

    [Theory]
    [InlineData("400")]
    [InlineData("401")]
    [InlineData("500")]
    public async Task Every_public_route_documents_the_envelope_it_fails_into(string status)
    {
        var document = await DocumentAsync();

        var missing = new List<string>();

        foreach (var path in document.GetProperty("paths").EnumerateObject())
        {
            // the /v1 group holds the exception filter, so its failure shape is a promise.
            // liveness is mapped on the root, outside both filters
            if (!path.Name.StartsWith("/v1/", StringComparison.Ordinal)) continue;
            if (path.Name == "/v1/health") continue;

            foreach (var operation in path.Value.EnumerateObject())
            {
                var found = operation.Value.GetProperty("responses")
                    .TryGetProperty(status, out var response)
                    && response.GetProperty("content").GetProperty("application/json")
                        .GetProperty("schema").GetProperty("$ref").GetString()
                    == "#/components/schemas/ConnectorErrorEnvelope";

                if (!found) missing.Add($"{operation.Name} {path.Name}");
            }
        }

        Assert.Empty(missing);
    }

    /// liveness answers one way: a probe needing a credential fails for the wrong reason,
    /// so it sits outside the envelope's group
    [Fact]
    public async Task Liveness_promises_nothing_but_the_one_answer_it_gives()
    {
        var document = await DocumentAsync();

        var codes = document.GetProperty("paths").GetProperty("/v1/health").GetProperty("get")
            .GetProperty("responses").EnumerateObject().Select(p => p.Name);

        Assert.Equal("200", Assert.Single(codes));
    }

    /// the schema generator reads the DI JSON options, not those given to Results.Json: AddConnectorPlatform copies the wire
    /// policy into ConfigureHttpJsonOptions, or fields would be documented under names never sent
    [Fact]
    public async Task The_documented_field_names_are_the_ones_that_go_on_the_wire()
    {
        var document = await DocumentAsync();

        var properties = document.GetProperty("components").GetProperty("schemas")
            .GetProperty("SessionResponse").GetProperty("properties")
            .EnumerateObject().Select(p => p.Name).ToList();

        Assert.Contains("session_id", properties);
        Assert.Contains("expires_at", properties);
        Assert.Contains("provider_account", properties);

        Assert.DoesNotContain("sessionId", properties);
        Assert.DoesNotContain("expiresAt", properties);
        Assert.DoesNotContain("providerAccount", properties);
    }

    [Fact]
    public async Task The_documented_enum_members_are_the_ones_that_go_on_the_wire()
    {
        var document = await DocumentAsync();

        var members = document.GetProperty("components").GetProperty("schemas")
            .GetProperty("JobStep").GetProperty("enum")
            .EnumerateArray().Select(m => m.GetString()).ToList();

        // snake_case, from the converter the wire policy carries
        Assert.Contains("opening_provider", members);
        Assert.Contains("awaiting_human", members);
        Assert.DoesNotContain("OpeningProvider", members);
    }
}
