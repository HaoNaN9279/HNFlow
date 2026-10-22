from unittest.mock import MagicMock, patch

from deerflow.tools.tools import get_available_tools


def _config() -> MagicMock:
    config = MagicMock()
    config.tools = []
    config.models = []
    config.tool_search.enabled = False
    config.skill_evolution.enabled = False
    config.sandbox = MagicMock()
    config.acp_agents = {}
    return config


@patch("deerflow.tools.tools.get_app_config")
@patch("deerflow.tools.tools.is_host_bash_allowed", return_value=True)
def test_workspace_tools_are_lead_agent_only(mock_bash, mock_cfg) -> None:
    mock_cfg.return_value = _config()
    subagent_names = {tool.name for tool in get_available_tools(include_mcp=False, app_config=mock_cfg.return_value)}
    lead_names = {
        tool.name
        for tool in get_available_tools(
            include_mcp=False,
            include_workspace_tools=True,
            app_config=mock_cfg.return_value,
        )
    }

    assert "workspace_catalog" not in subagent_names
    assert "workflow_manage" not in subagent_names
    assert {
        "workspace_catalog",
        "workspace_get",
        "workflow_manage",
        "workbench_manage",
        "workspace_undo",
    } <= lead_names
