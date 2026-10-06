using System.Text.Json;
using System.Text.Json.Nodes;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Munni.Api.Auth;
using Munni.Api.Connectors;
using Munni.Api.Validation;

namespace Munni.Api.Lab;

/// <summary>A retention bench run to start: the agent, the party and the resource it exercises.</summary>
public sealed record LabRetentionRunRequest(string Provider, string Resource, string? AgentId = null, string? AgentName = null, string? Label = null);

/// <summary>One step's verdict, written as the lab takes it; a step written twice is replaced by name.</summary>
public sealed record LabRetentionStepRequest(string Name, string State, string? Detail = null, string? JobId = null, string? SessionId = null);

/// <summary>The run's end: passed, failed or aborted.</summary>
public sealed record LabRetentionFinishRequest(string State);

/// <summary>A run as the lab lists it.</summary>
public sealed record LabRetentionRunDto(
    string Id,
    string? AgentId,
    string? AgentName,
    string Provider,
    string Resource,
    string? Label,
    string State,
    JsonNode? Steps,
    string? SessionId,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

public sealed class LabRetentionRunRequestValidator : AbstractValidator<LabRetentionRunRequest>
{
    public LabRetentionRunRequestValidator()
    {
        RuleFor(r => r.Provider).NotEmpty().MaximumLength(64).Matches("^[a-z0-9_-]+$");
        RuleFor(r => r.Resource).NotEmpty().MaximumLength(64).Matches("^[a-z0-9_-]+$");
        RuleFor(r => r.AgentId).MaximumLength(64).Matches("^[A-Za-z0-9._:-]+$").When(r => !string.IsNullOrEmpty(r.AgentId));
        RuleFor(r => r.AgentName).MaximumLength(128);
        RuleFor(r => r.Label).MaximumLength(128);
    }
}

public sealed class LabRetentionStepRequestValidator : AbstractValidator<LabRetentionStepRequest>
{
    public LabRetentionStepRequestValidator()
    {
        RuleFor(r => r.Name).NotEmpty().MaximumLength(32).Matches("^[a-z0-9-]+$");
        RuleFor(r => r.State).Must(s => LabRetentionEndpoints.StepStates.Contains(s)).WithMessage("a step is running, pass, fail or skip");
        RuleFor(r => r.Detail).MaximumLength(2000);
        RuleFor(r => r.JobId).MaximumLength(64);
        RuleFor(r => r.SessionId).MaximumLength(64);
    }
}

public sealed class LabRetentionFinishRequestValidator : AbstractValidator<LabRetentionFinishRequest>
{
    public LabRetentionFinishRequestValidator()
    {
        RuleFor(r => r.State).Must(s => LabRetentionEndpoints.EndStates.Contains(s)).WithMessage("a run ends passed, failed or aborted");
    }
}

/// <summary>
/// The retention bench's report store (#441 L4): the lab drives the scenario
/// through the bench's own routes and writes each step's verdict here, so a
/// run survives the tab that started it and the history can be read per
/// agent. Nothing here touches the control plane; the operator's own runs,
/// listed to the operator who made them.
/// </summary>
public static class LabRetentionEndpoints
{
    public const string Running = "running";

    public static readonly IReadOnlySet<string> StepStates = new HashSet<string>(StringComparer.Ordinal) { Running, "pass", "fail", "skip" };

    public static readonly IReadOnlySet<string> EndStates = new HashSet<string>(StringComparer.Ordinal) { "passed", "failed", "aborted" };

    private const int MaxListed = 100;

    private const int MaxSteps = 32;

    public static void Map(RouteGroupBuilder bench)
    {
        var runs = bench.MapGroup("/retention/runs");

        runs.MapGet("", List);
        runs.MapPost("", Create).WithValidation<LabRetentionRunRequest>();
        runs.MapGet("/{runId}", One);
        runs.MapPost("/{runId}/steps", Step).WithValidation<LabRetentionStepRequest>();
        runs.MapPost("/{runId}/finish", Finish).WithValidation<LabRetentionFinishRequest>();
        runs.MapDelete("/{runId}", Delete);
    }

    private static async Task<IResult> List(HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var userId = http.GetUserId();
        var rows = await relay.Db.LabRetentionRuns.AsNoTracking()
            .Where(r => r.UserId == userId)
            .OrderByDescending(r => r.CreatedAt)
            .Take(MaxListed)
            .ToListAsync(ct);
        return Results.Ok(rows.Select(Dto).ToList());
    }

    private static async Task<IResult> Create(LabRetentionRunRequest request, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var now = relay.Time.GetUtcNow();
        var row = new LabRetentionRun
        {
            Id = "lrr_" + Guid.NewGuid().ToString("N")[..20],
            UserId = http.GetUserId(),
            AgentId = string.IsNullOrEmpty(request.AgentId) ? null : request.AgentId,
            AgentName = request.AgentName,
            Provider = request.Provider,
            Resource = request.Resource,
            Label = request.Label,
            State = Running,
            CreatedAt = now,
            UpdatedAt = now,
        };
        relay.Db.LabRetentionRuns.Add(row);
        await relay.Db.SaveChangesAsync(ct);
        return Results.Json(Dto(row), statusCode: StatusCodes.Status201Created);
    }

    private static async Task<IResult> One(string runId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var row = await OwnAsync(relay, http, runId, ct);
        return row is null ? Results.NotFound() : Results.Ok(Dto(row));
    }

    /// <summary>A step's verdict, written in the order taken; the same name again replaces what it said before.</summary>
    private static async Task<IResult> Step(string runId, LabRetentionStepRequest request, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var row = await OwnAsync(relay, http, runId, ct);
        if (row is null) return Results.NotFound();
        if (row.State != Running) return Results.Conflict(new { error = "this run has ended" });

        var steps = JsonNode.Parse(row.StepsJson) as JsonArray ?? [];
        var existing = steps.FirstOrDefault(s => s?["name"]?.GetValue<string>() == request.Name);
        if (existing is null && steps.Count >= MaxSteps) return Results.Conflict(new { error = "too many steps" });

        var now = relay.Time.GetUtcNow();
        var step = new JsonObject
        {
            ["name"] = request.Name,
            ["state"] = request.State,
            ["detail"] = request.Detail,
            ["jobId"] = request.JobId,
            ["sessionId"] = request.SessionId,
            ["at"] = now,
        };

        if (existing is not null) steps[steps.IndexOf(existing)] = step;
        else steps.Add(step);

        if (request.SessionId is { Length: > 0 } sessionId) row.SessionId = sessionId;
        row.StepsJson = steps.ToJsonString();
        row.UpdatedAt = now;
        await relay.Db.SaveChangesAsync(ct);
        return Results.Ok(Dto(row));
    }

    private static async Task<IResult> Finish(string runId, LabRetentionFinishRequest request, HttpContext http, ConnectorRelay relay, ILogger<ConnectorClient> logger, CancellationToken ct)
    {
        var row = await OwnAsync(relay, http, runId, ct);
        if (row is null) return Results.NotFound();

        row.State = request.State;
        row.UpdatedAt = relay.Time.GetUtcNow();
        await relay.Db.SaveChangesAsync(ct);
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "operator {Operator} ended retention run {Run} on agent {Agent} for connector provider {Provider}: {State}",
                http.User.FindFirst("sub")?.Value ?? "-", row.Id, row.AgentId ?? "-", row.Provider, row.State);
        }
        return Results.Ok(Dto(row));
    }

    private static async Task<IResult> Delete(string runId, HttpContext http, ConnectorRelay relay, CancellationToken ct)
    {
        var row = await OwnAsync(relay, http, runId, ct);
        if (row is null) return Results.NotFound();

        relay.Db.LabRetentionRuns.Remove(row);
        await relay.Db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static Task<LabRetentionRun?> OwnAsync(ConnectorRelay relay, HttpContext http, string runId, CancellationToken ct) =>
        relay.Db.LabRetentionRuns.FirstOrDefaultAsync(r => r.Id == runId && r.UserId == http.GetUserId(), ct);

    private static LabRetentionRunDto Dto(LabRetentionRun row) => new(
        row.Id,
        row.AgentId,
        row.AgentName,
        row.Provider,
        row.Resource,
        row.Label,
        row.State,
        JsonNode.Parse(row.StepsJson, documentOptions: new JsonDocumentOptions { AllowTrailingCommas = true }),
        row.SessionId,
        row.CreatedAt,
        row.UpdatedAt);
}
